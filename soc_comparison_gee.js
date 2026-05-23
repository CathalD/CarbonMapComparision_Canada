// ══════════════════════════════════════════════════════════════════════════════
// SOC MAP COMPARISON PIPELINE — Google Earth Engine JavaScript
// Spatial comparison of soil organic carbon map products over Canada
// Reference: Sothe et al. (2022) Global Biogeochemical Cycles
// Canonical grid: 250 m, EPSG:3978 (NAD83 / Canada Atlas Lambert)
//
// Architecture note: this script handles ALL raster operations.
// Statistical analysis and figures are produced by soc_comparison_analysis.R,
// which consumes the CSV and GeoTIFF outputs exported here.
//
// Band names and asset paths verified against Charlie's Place KBA v4.2
// (Forest Carbon Assessment, blue-carbon-hub / north-star-project-470316):
//   - Sothe SC: sat-io community catalog ImageCollection (no user upload needed)
//   - SoilGrids OCS: depth-integrated from soc_mean + bdod_mean using the
//     same formula verified in Charlie's Place v4.2:
//     OCS (kg/m²) = SOC(dg/kg)/10 × BDOD(cg/cm³)/100 × thickness(cm)/100
//     summed over 0-5, 5-15, 15-30, 30-60, 60-100 cm → 0-100 cm total.
//   - SoilGrids SOC band names confirmed: soc_0-5cm_mean … soc_60-100cm_mean
//   - SoilGrids BDOD band names confirmed: bdod_0-5cm_mean … bdod_60-100cm_mean
// ══════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 0 — CONFIG BLOCK
// All user-editable variables are defined here. Nothing is hardcoded elsewhere.
//
// Assets now confirmed available without user upload:
//   SOTHE_STOCK_ASSET — sat-io community catalog (ImageCollection)
//   SoilGrids         — computed from community catalog soc_mean + bdod_mean
//
// User must still supply:
//   SOTHE_STOCK_BAND  — run bandNames() check below to confirm (see Section 4.1)
//   SOTHE_UNC_ASSET   — Sothe uncertainty raster (upload from Zenodo v3.0)
//   SOTHE_UNC_BAND    — band name in that asset
//   GEE_USERNAME      — your GEE username
//   ECOZONES_ASSET    — Canada ecozones FeatureCollection asset path
// ─────────────────────────────────────────────────────────────────────────────

// ── Sothe et al. (2022) — soil carbon stock ──────────────────────────────────
// Available via the sat-io GEE community catalog. No upload required.
// Run this in a new script to confirm the native band name before proceeding:
//   print(ee.ImageCollection('projects/sat-io/open-datasets/carbon_stocks_ca/sc')
//           .first().bandNames());
var SOTHE_STOCK_ASSET = 'projects/sat-io/open-datasets/carbon_stocks_ca/sc';
var SOTHE_STOCK_BAND  = 'VERIFY_BAND_NAME';  // fill after bandNames() check above

// ── Sothe uncertainty — upload from Zenodo doi:10.4121/16686154.v3 ──────────
var SOTHE_UNC_ASSET   = 'PLACEHOLDER_SOTHE_UNC_ASSET';
var SOTHE_UNC_BAND    = 'PLACEHOLDER_SOTHE_UNC_BAND';

// ── GEE account and ecozone boundary ─────────────────────────────────────────
var GEE_USERNAME   = 'PLACEHOLDER_GEE_USERNAME';
var ECOZONES_ASSET = 'PLACEHOLDER_ECOZONES_ASSET';

// ── Canonical grid ────────────────────────────────────────────────────────────
var CANONICAL_CRS       = 'EPSG:3978';  // NAD83 / Canada Atlas Lambert
var CANONICAL_SCALE     = 250;          // metres
var OUTPUT_UNIT         = 'kg/m2';      // all raster outputs in this unit
var SOTHE_MIN_THRESHOLD = 0.1;
// Minimum Sothe value (kg/m²) below which relative difference is masked.
// Prevents division instability in near-zero pixels (water, ice, bare rock).

var ASSET_ROOT = 'users/' + GEE_USERNAME + '/SOC_comparison/';

// ── Startup checks ────────────────────────────────────────────────────────────
// Throws before any GEE computation if required placeholders are not filled.
var _required = {
  SOTHE_UNC_ASSET:  SOTHE_UNC_ASSET,
  SOTHE_UNC_BAND:   SOTHE_UNC_BAND,
  GEE_USERNAME:     GEE_USERNAME,
  ECOZONES_ASSET:   ECOZONES_ASSET
};
Object.keys(_required).forEach(function(k) {
  if (_required[k].indexOf('PLACEHOLDER') !== -1) {
    throw new Error('CONFIG incomplete — fill in: ' + k);
  }
});
// Non-fatal warning for values that still need a bandNames() verification step.
if (SOTHE_STOCK_BAND.indexOf('VERIFY') !== -1) {
  print('⚠ WARNING: SOTHE_STOCK_BAND is still "' + SOTHE_STOCK_BAND + '".');
  print('  Run the one-liner in the SECTION 0 comment to confirm the band name,');
  print('  then update SOTHE_STOCK_BAND before running exports.');
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — HARMONIZATION HELPER
// harmonize(image, nativeScaleMetres, layerID)
// Reprojects any image to CANONICAL_CRS at CANONICAL_SCALE.
// For inputs finer than the canonical scale, applies mean aggregation first
// to preserve areal mass balance. Bilinear resampling is explicitly not used —
// it alters pixel values without physical justification for carbon stocks.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Harmonize an image to the canonical CRS and pixel scale.
 * @param {ee.Image} image             - Input image (already unit-converted).
 * @param {number}   nativeScaleMetres - Native pixel size in metres.
 * @param {string}   layerID           - Short label for console messages.
 * @returns {ee.Image} Image at CANONICAL_CRS / CANONICAL_SCALE.
 */
function harmonize(image, nativeScaleMetres, layerID) {
  if (nativeScaleMetres < CANONICAL_SCALE) {
    // Finer resolution: aggregate to canonical scale before reprojecting.
    // Mean aggregation preserves areal mass balance for carbon stock layers.
    print(layerID + ': aggregated from ' + nativeScaleMetres + 'm to 250m via mean');
    return image
      .reduceResolution({
        reducer:    ee.Reducer.mean(),
        bestEffort: false,
        maxPixels:  1024
      })
      .reproject({
        crs:   CANONICAL_CRS,
        scale: CANONICAL_SCALE
      });
  } else {
    // Native resolution >= canonical: reproject directly.
    print(layerID + ': reprojected to 250m (native >= 250m)');
    return image.reproject({
      crs:   CANONICAL_CRS,
      scale: CANONICAL_SCALE
    });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — LAYER REGISTRY
// LAYERS is the single extension point for adding products.
// Adding a layer means adding one descriptor object here — no changes are
// needed anywhere else in the script.
//
// Standard fields (all layers):
//   id, citation, assetPath, bandName, nativeUnit, convFactor, convNote,
//   nativeScale, depthInterval, hasUncertainty, uncAssetPath, uncBandName,
//   uncConvFactor, isReference, spatialExtent
//
// Optional fields:
//   isCollection  : true if assetPath is an ImageCollection (use .first())
//   computeOCS    : true if stock must be depth-integrated from SOC + BDOD
//                   (SoilGrids case). See loadLayer() for the formula.
//   socAssetPath  : SOC concentration image path (when computeOCS: true)
//   bdodAssetPath : bulk density image path (when computeOCS: true)
//   socBands      : array of SOC band names per depth (when computeOCS: true)
//   bdodBands     : array of BDOD band names per depth (when computeOCS: true)
//   thicknessCm   : array of layer thicknesses in cm (when computeOCS: true)
// ─────────────────────────────────────────────────────────────────────────────

var LAYERS = [

  // ── REFERENCE LAYER — Sothe et al. (2022) ────────────────────────────────
  // Available via sat-io GEE community catalog. No upload required.
  // The collection holds the Canada-wide 250 m soil carbon stock raster.
  // Run the one-liner in SECTION 0 to confirm the native band name.
  {
    id:             'sothe_gbc',
    citation:       'Sothe et al. (2022), Global Biogeochemical Cycles, ' +
                    '36, e2021GB007213. doi:10.1029/2021GB007213. ' +
                    'Dataset v3.0: doi:10.4121/16686154.v3. ' +
                    'Community catalog: projects/sat-io/open-datasets/carbon_stocks_ca/',
    assetPath:      SOTHE_STOCK_ASSET,    // ImageCollection — loadLayer() calls .first()
    bandName:       SOTHE_STOCK_BAND,     // verify with bandNames() before running
    isCollection:   true,                 // load as ImageCollection, take .first()
    nativeUnit:     'kg/m²',
    convFactor:     1,
    // kg/m² × 1.0 = kg/m²   [Native unit is kg/m² — no conversion required]
    convNote:       'Native unit is kg/m² — no conversion required.',
    nativeScale:    250,
    depthInterval:  '0-1m',
    hasUncertainty: true,
    uncAssetPath:   SOTHE_UNC_ASSET,
    uncBandName:    SOTHE_UNC_BAND,
    uncConvFactor:  1,
    // kg/m² × 1.0 = kg/m²   [Native unit is kg/m² — no conversion required]
    isReference:    true,
    spatialExtent:  'Canada (wall-to-wall)'
  },

  // ── COMPARISON LAYER 1 — SoilGrids 2.0 ───────────────────────────────────
  // Available via the GEE community catalog. No upload required.
  // OCS is computed by depth-integrating SOC concentration (dg/kg) with
  // bulk density (cg/cm³) across five standard depth intervals.
  // Formula verified against Charlie's Place KBA v4.2 implementation:
  //   OCS_layer (kg/m²) = SOC(dg/kg)/10 × BDOD(cg/cm³)/100 × thickness(cm)/100
  //
  // ── BAND NAME VERIFICATION ──────────────────────────────────────────────
  // SOC and BDOD band names are CONFIRMED from Charlie's Place v4.2.
  // Paste the following into a new GEE script to double-check before running:
  //   print('SOC bands:',  ee.Image('projects/soilgrids-isric/soc_mean').bandNames());
  //   print('BDOD bands:', ee.Image('projects/soilgrids-isric/bdod_mean').bandNames());
  //
  // ── UNIT VERIFICATION ───────────────────────────────────────────────────
  // SOC:  stored as dg/kg (decigrams per kilogram). Divide by 10 → g/kg.
  // BDOD: stored as cg/cm³ (centigrams per cm³). Divide by 100 → g/cm³.
  // OCS = SOC(g/kg) × BDOD(g/cm³) × thickness(m) / 1000 × 1000 = kg/m²
  // Numerical check (typical boreal mineral soil):
  //   SOC 20 dg/kg → 2 g/kg; BDOD 120 cg/cm³ → 1.2 g/cm³; thickness 5 cm
  //   OCS = 2/10... no, use formula: 20/10 × 120/100 × 5/100 = 0.12 kg/m²
  //   Manual check: 2 g/kg × 1.2 g/cm³ × 0.05 m → 0.12 kg/m² ✓
  {
    id:             'soilgrids',
    citation:       'Poggio et al. (2021), SOIL 7:217-240. ' +
                    'doi:10.5194/soil-7-217-2021. ' +
                    'GEE community catalog: projects/soilgrids-isric/',
    //
    // computeOCS: true activates depth-integration in loadLayer().
    // Fields below replace the single assetPath/bandName approach.
    //
    computeOCS:     true,
    assetPath:      'projects/soilgrids-isric/soc_mean',   // SOC concentration by depth
    bandName:       'soc_0-5cm_mean',  // first SOC depth band (used for diagnostics only)
    bdodAssetPath:  'projects/soilgrids-isric/bdod_mean',  // bulk density by depth
    //
    // Band names confirmed from Charlie's Place KBA v4.2 (Step 2 diagnostics).
    // Each socBand[i] pairs with bdodBands[i] and thicknessCm[i].
    socBands:       ['soc_0-5cm_mean',   'soc_5-15cm_mean',  'soc_15-30cm_mean',
                     'soc_30-60cm_mean', 'soc_60-100cm_mean'],
    bdodBands:      ['bdod_0-5cm_mean',  'bdod_5-15cm_mean', 'bdod_15-30cm_mean',
                     'bdod_30-60cm_mean','bdod_60-100cm_mean'],
    thicknessCm:    [5, 10, 15, 30, 40],
    // Thicknesses: 0-5=5 cm, 5-15=10 cm, 15-30=15 cm, 30-60=30 cm, 60-100=40 cm
    // Sum = 100 cm = 1 m ✓
    //
    nativeUnit:     'dg/kg (SOC) + cg/cm³ (BDOD)',
    convFactor:     1,  // unit conversion applied internally in computeOCS()
    // SOC: dg/kg / 10 = g/kg   BDOD: cg/cm³ / 100 = g/cm³   thickness: cm / 100 = m
    // OCS (kg/m²) = SOC(g/kg) × BDOD(g/cm³) × thickness(m), summed over all layers
    convNote:       'SOC(dg/kg)/10 × BDOD(cg/cm³)/100 × thickness(cm)/100 → kg/m² per layer; ' +
                    'summed over 0-5, 5-15, 15-30, 30-60, 60-100 cm = 0-100 cm total.',
    nativeScale:    250,
    depthInterval:  '0-1m',
    hasUncertainty: true,
    //
    // SoilGrids uncertainty: derived from Q0.05 and Q0.95 SOC quantile bands.
    // The quantile asset path and band names need a bandNames() check:
    //   print(ee.Image('projects/soilgrids-isric/soc_p5').bandNames());
    //   print(ee.Image('projects/soilgrids-isric/soc_p95').bandNames());
    // Expected band names follow the same depth convention:
    //   soc_0-5cm_p5, soc_0-5cm_p95, etc. (or Q0.05 / Q0.95 — verify)
    // Once confirmed, uncertainty is computed from OCS_Q95 - OCS_Q05 (same
    // depth-integration formula applied separately to Q05 and Q95 bands),
    // then divided by (2 × 1.645) to approximate 1-sigma assuming normality.
    // This underestimates uncertainty in right-skewed peatland distributions
    // — flagged in README Section 7.
    //
    uncAssetPath:   'projects/soilgrids-isric/soc_p5',    // VERIFY this asset path
    uncBandName:    'VERIFY_SOC_Q05_BANDS',                // fill after bandNames() check
    // Paired Q95 asset (loaded separately in loadLayer() for soilgrids uncertainty):
    uncQ95AssetPath:'projects/soilgrids-isric/soc_p95',   // VERIFY this asset path
    uncQ95BandName: 'VERIFY_SOC_Q95_BANDS',               // fill after bandNames() check
    uncConvFactor:  1,  // same depth-integration applied to Q05/Q95 in loadLayer()
    isReference:    false,
    spatialExtent:  'Global (clipped to Sothe mask for this analysis)'
  }

];  // end LAYERS


// ── FUTURE LAYER STUBS (commented out) ──────────────────────────────────────
// To activate a layer: uncomment, fill all fields, re-run Groups B–D only.
/*

  // Geng et al. 2025 — Agriculture Canada 100m
  //
  // BEFORE ACTIVATING: confirm from Zenodo metadata whether this is a stock
  // (kg/m²) or a concentration (g/kg) product. If concentration, bulk density
  // multiplication and depth integration are required before convFactor applies.
  // Do not activate without resolving — the convFactor below assumes stock.
  //
  {
    id:             'geng_2025',
    citation:       'Geng et al. (2025), Scientific Data 12:1178. ' +
                    'doi:10.1038/s41597-025-05460-4. ' +
                    'Dataset: doi:10.5281/zenodo.15473720',
    assetPath:      'PLACEHOLDER_GENG_ASSET',  // upload from Zenodo; see README Section 3.2
    bandName:       'PLACEHOLDER_BAND',
    isCollection:   false,
    nativeUnit:     'CONFIRM_FROM_DATA_DOCS',
    convFactor:     'CONFIRM',
    convNote:       'CONFIRM unit from Zenodo metadata before activating.',
    nativeScale:    100,      // triggers mean aggregation to 250m in harmonize()
    depthInterval:  '0-1m',  // confirm from data documentation
    hasUncertainty: true,
    uncAssetPath:   'PLACEHOLDER_GENG_UNC_ASSET',
    uncBandName:    'PLACEHOLDER',
    uncConvFactor:  'CONFIRM',
    isReference:    false,
    spatialExtent:  'Canada (national, agriculture-focused)'
  },

  // Hengl et al. 2023 — Alberta 30m
  // Unit check: 1 t/ha = 1 Mg/ha = 10,000 kg / 10,000 m² = 0.1 kg/m²
  {
    id:             'hengl_2023',
    citation:       'Hengl et al. (2023), FACETS 8:1-17. ' +
                    'doi:10.1139/facets-2023-0040',
    assetPath:      'PLACEHOLDER_HENGL_ASSET',  // upload from source; see README Section 3.2
    bandName:       'PLACEHOLDER_BAND',
    isCollection:   false,
    nativeUnit:     't/ha',
    convFactor:     0.1,
    // t/ha × 0.1 = kg/m²   [1 t/ha = 1 Mg/ha = 10,000 kg / 10,000 m² = 0.1 kg/m²]
    convNote:       't/ha × 0.1 → kg/m². (1 t/ha = 0.1 kg/m²)',
    nativeScale:    30,       // triggers mean aggregation to 250m in harmonize()
    depthInterval:  '0-1m',
    hasUncertainty: false,
    uncAssetPath:   null,
    uncBandName:    null,
    uncConvFactor:  null,
    isReference:    false,
    spatialExtent:  'Alberta agricultural lands only'
  }

*/


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — LOAD, CONVERT, AND HARMONIZE
// loadLayer(layerDef) → { stock: ee.Image, unc: ee.Image|null, def: Object }
//
// Handles three load modes based on layer descriptor fields:
//   A. isCollection: true  — load ImageCollection, take .first() (Sothe SC)
//   B. computeOCS: true    — depth-integrate from SOC + BDOD images (SoilGrids)
//   C. default             — load single Image, select band (future layers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute depth-integrated OCS (kg/m²) from SoilGrids soc_mean and bdod_mean.
 * Formula verified against Charlie's Place KBA v4.2 (Step 2):
 *   OCS_layer = SOC(dg/kg)/10 × BDOD(cg/cm³)/100 × thickness(cm)/100  [kg/m²]
 * @param {Object}   layerDef  - LAYERS descriptor with computeOCS:true fields.
 * @param {ee.Image} socImg    - Full soc_mean image (all depth bands).
 * @param {ee.Image} bdodImg   - Full bdod_mean image (all depth bands).
 * @returns {ee.Image} Single-band image of total OCS 0-100cm in kg/m².
 */
function computeOCSFromDepths(layerDef, socImg, bdodImg) {
  var layerImages = layerDef.socBands.map(function(socBand, i) {
    var bdBand    = layerDef.bdodBands[i];
    var thickness = layerDef.thicknessCm[i];
    // SOC: dg/kg / 10 = g/kg   BDOD: cg/cm³ / 100 = g/cm³   thickness: cm / 100 = m
    // OCS (kg/m²) = g/kg × g/cm³ × m  [verified numerically; see LAYERS comment]
    return socImg.select(socBand).divide(10)
      .multiply(bdodImg.select(bdBand).divide(100))
      .multiply(thickness)
      .divide(100);
  });

  // Sum all depth layers (0-5, 5-15, 15-30, 30-60, 60-100 cm) → 0-100 cm total
  var totalOCS = ee.ImageCollection.fromImages(layerImages).sum();
  return totalOCS.rename(layerDef.id + '_kgm2');
}

/**
 * Load a layer descriptor: select band, apply unit conversion, harmonize to
 * canonical grid, and optionally load/derive uncertainty.
 * @param {Object} layerDef - One descriptor object from the LAYERS array.
 * @returns {{ stock: ee.Image, unc: ee.Image|null, def: Object }}
 */
function loadLayer(layerDef) {
  var stock, unc;

  // ── Mode B: SoilGrids depth-integrated OCS ──────────────────────────────
  if (layerDef.computeOCS === true) {

    // Print band inventories before use — confirms band names at runtime.
    var socImg  = ee.Image(layerDef.assetPath);
    var bdodImg = ee.Image(layerDef.bdodAssetPath);

    socImg.bandNames().evaluate(function(bands) {
      print('SoilGrids soc_mean — available bands:', bands);
    });
    bdodImg.bandNames().evaluate(function(bands) {
      print('SoilGrids bdod_mean — available bands:', bands);
    });

    stock = computeOCSFromDepths(layerDef, socImg, bdodImg);
    stock = harmonize(stock, layerDef.nativeScale, layerDef.id);

    // ── SoilGrids uncertainty: depth-integrated from Q05 and Q95 SOC bands
    // Both Q05 and Q95 are treated as SOC values in the same units as soc_mean.
    // OCS_Q05 and OCS_Q95 are computed via the same depth-integration formula,
    // then 1-sigma ≈ (OCS_Q95 - OCS_Q05) / (2 × 1.645).
    // Underestimates uncertainty in right-skewed peatland distributions —
    // see README Section 7.
    if (layerDef.hasUncertainty &&
        layerDef.uncBandName.indexOf('VERIFY') === -1 &&
        layerDef.uncQ95BandName.indexOf('VERIFY') === -1) {

      // Build a mock layer descriptor for Q05 (same depth bands, same formula)
      var q05Def = {
        socBands:    layerDef.socBands.map(function(b) {
          return b.replace('_mean', '_p5');   // adjust suffix after bandNames() check
        }),
        bdodBands:   layerDef.bdodBands,
        thicknessCm: layerDef.thicknessCm,
        id:          layerDef.id + '_q05'
      };
      var q95Def = {
        socBands:    layerDef.socBands.map(function(b) {
          return b.replace('_mean', '_p95');  // adjust suffix after bandNames() check
        }),
        bdodBands:   layerDef.bdodBands,
        thicknessCm: layerDef.thicknessCm,
        id:          layerDef.id + '_q95'
      };

      var q05Img = ee.Image(layerDef.uncAssetPath);
      var q95Img = ee.Image(layerDef.uncQ95AssetPath);

      var ocs_q05 = computeOCSFromDepths(q05Def, q05Img, bdodImg);
      var ocs_q95 = computeOCSFromDepths(q95Def, q95Img, bdodImg);

      // Convert 90% prediction interval to approximate 1-sigma
      unc = ocs_q95.subtract(ocs_q05)
                   .divide(2 * 1.645)
                   .rename(layerDef.id + '_unc_kgm2');
      unc = harmonize(unc, layerDef.nativeScale, layerDef.id + '_unc');

    } else {
      unc = null;
      if (layerDef.hasUncertainty) {
        print('⚠ ' + layerDef.id + ': uncertainty skipped — verify uncBandName / uncQ95BandName ' +
              'then remove VERIFY_ prefix to activate.');
      }
    }

    return { stock: stock, unc: unc, def: layerDef };
  }

  // ── Mode A: ImageCollection — take first image (Sothe community catalog) ──
  if (layerDef.isCollection === true) {
    var col = ee.ImageCollection(layerDef.assetPath);
    // Print band names at load time so user can confirm SOTHE_STOCK_BAND.
    col.first().bandNames().evaluate(function(bands) {
      print('Sothe SC community catalog — available bands:', bands);
      if (bands.indexOf(layerDef.bandName) === -1) {
        print('⚠ WARNING: band "' + layerDef.bandName + '" not found in Sothe SC. ' +
              'Update SOTHE_STOCK_BAND in Section 0 to one of: ' + bands.join(', '));
      }
    });
    var baseImg = col.first();
    stock = baseImg.select(layerDef.bandName)
      // kg/m² × 1.0 = kg/m²   [Native unit is kg/m² — no conversion required]
      .multiply(layerDef.convFactor)
      .rename(layerDef.id + '_kgm2');
    stock = harmonize(stock, layerDef.nativeScale, layerDef.id);

  } else {
    // ── Mode C: standard single Image ──────────────────────────────────────
    stock = ee.Image(layerDef.assetPath)
      .select(layerDef.bandName)
      // [nativeUnit] × convFactor = kg/m²   (see convNote in layer descriptor)
      .multiply(layerDef.convFactor)
      .rename(layerDef.id + '_kgm2');
    stock = harmonize(stock, layerDef.nativeScale, layerDef.id);
  }

  // ── Uncertainty for non-SoilGrids layers (direct load) ───────────────────
  unc = null;
  if (layerDef.hasUncertainty && layerDef.uncAssetPath && layerDef.uncBandName) {
    unc = ee.Image(layerDef.uncAssetPath)
      .select(layerDef.uncBandName)
      // [nativeUnit] × uncConvFactor = kg/m²
      .multiply(layerDef.uncConvFactor)
      .rename(layerDef.id + '_unc_kgm2');
    unc = harmonize(unc, layerDef.nativeScale, layerDef.id + '_unc');
  }

  return { stock: stock, unc: unc, def: layerDef };
}

// ── Separate reference layer from comparison layers ───────────────────────
var ref = null;
var compLayers = [];  // array of { stock, unc, def }

// Client-side iteration over plain JS array — no server-side objects here.
LAYERS.forEach(function(layerDef) {
  var loaded = loadLayer(layerDef);
  if (layerDef.isReference) {
    ref = loaded;
  } else {
    compLayers.push(loaded);
  }
});

if (ref === null) {
  throw new Error('No isReference:true layer found in LAYERS registry.');
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — MASKING
// ─────────────────────────────────────────────────────────────────────────────

// ── Primary analysis mask ─────────────────────────────────────────────────
// Sothe is the spatial frame of reference. All difference outputs are masked
// to this extent. Comparisons are valid wherever each comparison layer
// overlaps Sothe — layers don't need to be simultaneously valid.
var refMask = ref.stock.gt(SOTHE_MIN_THRESHOLD).selfMask();
// Excludes water, ice, bare rock, and very low-SOC mineral soils where
// Sothe SOC < SOTHE_MIN_THRESHOLD. Prevents relative difference instability
// from near-zero denominators.

// ── 4a: n_valid — per-pixel count of layers with valid data ──────────────
// Range: 1 (only Sothe) to N (all layers present at this pixel).
var allStocks = [ref.stock].concat(
  compLayers.map(function(c) { return c.stock; })
);
var n_valid = ee.ImageCollection.fromImages(allStocks)
  .count()
  .rename('n_valid');

// ── 4b: zero_vs_null — per-layer pixel data status ───────────────────────
// Class 0 = masked (no data at this pixel)
// Class 1 = valid value > 0
// Class 2 = unmasked but value equals 0 (explicit zero)
//
// Distinguishes products that mask non-vegetated areas (class 0) from those
// that return an explicit zero (class 2). Both look identical in a difference
// raster but have different scientific meaning: class 0 means the product
// does not attempt to model this land type; class 2 means it models it as
// carbon-free.
var zvnBands = allStocks.map(function(img) {
  var bandLabel = img.bandNames().get(0);
  var valid   = img.gt(0).unmask(0);          // 1 where value > 0
  var isZero  = img.eq(0).unmask(0);          // 1 where value == 0
  var notNull = img.mask().unmask(0);          // 1 where pixel is not masked
  return valid
    .add(isZero.multiply(2).multiply(notNull))
    .rename(ee.String(bandLabel).cat('_zvn'));
});
var zero_vs_null = ee.Image.cat(zvnBands);

// ── 4c: mask_agreement — pixels where ALL layers have valid data ──────────
var totalLayerCount = LAYERS.length;
var mask_agree = n_valid
  .eq(totalLayerCount)
  .rename('mask_agree')
  .selfMask();
// Masked wherever any layer is missing. Use for analyses that require
// simultaneous coverage across every product in the registry.


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — DIFFERENCE RASTERS
// computeDifferences(compResult, refResult) → object of named ee.Images
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute all difference metrics between one comparison layer and the reference.
 * @param {Object} compResult - { stock, unc, def } for the comparison layer.
 * @param {Object} refResult  - { stock, unc, def } for the reference layer.
 * @returns {Object} Named ee.Image outputs.
 */
function computeDifferences(compResult, refResult) {
  var layerID = compResult.def.id;
  var comp    = compResult.stock;
  var refImg  = refResult.stock;

  // ── 5a: Absolute difference (kg/m², signed) ────────────────────────────
  // Positive = comparison layer reports MORE carbon than Sothe at this pixel.
  var diff_abs = comp
    .subtract(refImg)
    .updateMask(refMask)
    .rename(layerID + '_diff_abs_kgm2');

  // ── 5b: Relative difference (%, signed) ────────────────────────────────
  // Masked where Sothe < SOTHE_MIN_THRESHOLD to prevent division instability
  // from near-zero denominators (water, ice, and bare-rock pixels).
  // Large relative differences in high-SOC peatland pixels are more
  // interpretively meaningful than in low-SOC mineral soil pixels.
  var diff_rel = comp
    .subtract(refImg)
    .divide(refImg.max(SOTHE_MIN_THRESHOLD))
    .multiply(100)
    .updateMask(refMask)
    .updateMask(refImg.gt(SOTHE_MIN_THRESHOLD))
    .rename(layerID + '_diff_rel_pct');

  // ── 5c: Uncertainty-normalized difference — Sothe uncertainty only ─────
  // |value| > 1 = disagreement exceeds Sothe 1-sigma uncertainty.
  // Minimum uncertainty-aware test: does not account for comparison layer
  // uncertainty, so it overstates significance where the comparison product
  // itself has high uncertainty.
  var diff_norm_sothe = comp
    .subtract(refImg)
    .divide(refResult.unc)
    .updateMask(refMask)
    .updateMask(refResult.unc.gt(0))
    // Masked where Sothe uncertainty = 0 to avoid division by zero.
    .rename(layerID + '_diff_norm_sothe');

  var result = {
    diff_abs:           diff_abs,
    diff_rel:           diff_rel,
    diff_norm_sothe:    diff_norm_sothe,
    diff_norm_combined: null
  };

  // ── 5c continued: combined uncertainty (requires both products to have unc)
  // |value| > 1 = disagreement exceeds combined 1-sigma of both products.
  // Most conservative test. Pixels with |value| > 2 are high-priority
  // targets for field validation, as disagreement cannot be explained by
  // either product's reported uncertainty.
  if (compResult.unc !== null) {
    var combinedUnc = refResult.unc.pow(2).add(compResult.unc.pow(2)).sqrt();
    result.diff_norm_combined = comp
      .subtract(refImg)
      .divide(combinedUnc)
      .updateMask(refMask)
      .updateMask(combinedUnc.gt(0))
      // Masked where combined uncertainty = 0 (extremely rare, guarding
      // against degenerate pixels where both products report unc = 0).
      .rename(layerID + '_diff_norm_combined');
  }

  return result;
}

// ── Compute differences for all comparison layers ─────────────────────────
var compResults = compLayers.map(function(compResult) {
  return {
    layerID: compResult.def.id,
    diffs:   computeDifferences(compResult, ref),
    stock:   compResult.stock,
    unc:     compResult.unc,
    def:     compResult.def
  };
});


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — CROSS-PRODUCT UNCERTAINTY ANALYSIS
// Quantifies the ensemble spread across all comparison layers, independent of
// any individual product's reported uncertainty.
// ─────────────────────────────────────────────────────────────────────────────

// ImageCollection of all harmonized comparison stocks (not including reference).
var compCollection = ee.ImageCollection.fromImages(
  compLayers.map(function(c) { return c.stock; })
);

// ── 6a: Cross-product mean (kg/m²) ────────────────────────────────────────
var crossMean = compCollection
  .mean()
  .updateMask(refMask)
  .rename('cross_mean_kgm2');

// ── 6b: Cross-product standard deviation — empirical ensemble spread (kg/m²)
// With N=2 layers this equals half the absolute difference.
// With N>2 layers it becomes a true spread measure across the product ensemble.
var crossSD = compCollection
  .reduce(ee.Reducer.stdDev())
  .updateMask(refMask)
  .rename('cross_sd_kgm2');

// ── 6c: Spread-to-Sothe-uncertainty ratio (dimensionless) ─────────────────
// Values > 1 = cross-product disagreement exceeds Sothe's reported uncertainty.
// Spatial hotspots where this ratio is high are regions where additional field
// validation campaigns would most reduce national SOC mapping uncertainty.
var spreadRatio = crossSD
  .divide(ref.unc)
  .updateMask(refMask)
  .updateMask(ref.unc.gt(0))
  // Masked where Sothe uncertainty = 0 to avoid division by zero.
  .rename('spread_vs_sothe_unc');


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — ZONAL SUMMARY TABLE
// Computes per-ecozone statistics over all difference bands.
// Exports both as a GEE FeatureCollection asset and as a CSV to Google Drive.
// The CSV is the intended handoff point to soc_comparison_analysis.R.
// ─────────────────────────────────────────────────────────────────────────────

var ecozones = ee.FeatureCollection(ECOZONES_ASSET);
// Fallback if no ecozones asset available — uncomment and substitute above:
// var ecozones = ee.FeatureCollection('RESOLVE/ECOREGIONS/2017')
//                 .filter(ee.Filter.bounds(ref.stock.geometry()));

// Stack all difference bands into a single multiband image for zonal reduction.
var diffBandImages = [];

compResults.forEach(function(cr) {
  diffBandImages.push(cr.diffs.diff_abs);
  diffBandImages.push(cr.diffs.diff_rel);
  diffBandImages.push(cr.diffs.diff_norm_sothe);
  if (cr.diffs.diff_norm_combined !== null) {
    diffBandImages.push(cr.diffs.diff_norm_combined);
  }
  diffBandImages.push(cr.stock);
  if (cr.unc !== null) {
    diffBandImages.push(cr.unc);
  }
});

// Also stack reference and cross-product bands for completeness.
diffBandImages.push(ref.stock);
diffBandImages.push(ref.unc);
diffBandImages.push(crossMean);
diffBandImages.push(crossSD);
diffBandImages.push(spreadRatio);

var stackedDiffs = ee.Image.cat(diffBandImages);

// Compute multi-statistic zonal summary per ecozone feature.
// tileScale: 4 is required at Canada-wide 250m to avoid memory errors.
var zonalResult = stackedDiffs.reduceRegions({
  collection: ecozones,
  reducer:    ee.Reducer.mean()
              .combine(ee.Reducer.median(),             '', true)
              .combine(ee.Reducer.stdDev(),             '', true)
              .combine(ee.Reducer.percentile([10, 90]), '', true),
  scale:      CANONICAL_SCALE,
  crs:        CANONICAL_CRS,
  tileScale:  4   // required at Canada-wide 250m to avoid memory errors
});

// Export zonal result as a persistent GEE FeatureCollection asset.
Export.table.toAsset({
  collection:  zonalResult,
  description: 'SOC_zonal_ecozones',
  assetId:     ASSET_ROOT + 'SOC_zonal_ecozones'
});

// Export CSV to Google Drive — this is the handoff to soc_comparison_analysis.R.
// Download GEE_Exports/SOC_zonal_ecozones.csv from Drive and point the R script
// CSV_DIR variable to the folder containing it.
Export.table.toDrive({
  collection:     zonalResult,
  description:    'SOC_zonal_ecozones_csv',
  folder:         'GEE_Exports',
  fileNamePrefix: 'SOC_zonal_ecozones',
  fileFormat:     'CSV'
});


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — ASSET EXPORT PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Export an image as a persistent GEE asset.
 * @param {ee.Image} image       - Image to export.
 * @param {string}   shortName   - Asset filename (appended to ASSET_ROOT).
 * @param {string}   description - Human-readable task name in Tasks tab.
 */
function exportAsset(image, shortName, description) {
  Export.image.toAsset({
    image:       image,
    description: description,
    assetId:     ASSET_ROOT + shortName,
    crs:         CANONICAL_CRS,
    scale:       CANONICAL_SCALE,
    maxPixels:   1e13,
    region:      ref.stock.geometry()
  });
}

/**
 * Export an image to Google Drive as a GeoTIFF.
 * Use for layers that need to be loaded locally in R via terra or tmap.
 * @param {ee.Image} image       - Image to export.
 * @param {string}   fileName    - File name prefix in Drive folder.
 * @param {string}   description - Human-readable task name in Tasks tab.
 */
function exportDrive(image, fileName, description) {
  Export.image.toDrive({
    image:          image,
    description:    description,
    folder:         'GEE_Exports',
    fileNamePrefix: fileName,
    crs:            CANONICAL_CRS,
    scale:          CANONICAL_SCALE,
    maxPixels:      1e13,
    region:         ref.stock.geometry(),
    fileFormat:     'GeoTIFF'
  });
}

// ── Group A: Reference verification — SUBMIT FIRST ───────────────────────
// After export, visually inspect sothe_stock_kgm2 in the GEE asset viewer.
// Expected values for Sothe 0-1m:
//   Boreal peatland (Hudson Bay Lowlands):     ~40–80 kg/m²
//   Boreal forest (mixed mineral soil):         ~5–20 kg/m²
//   Prairie (agricultural, Alberta):            ~3–10 kg/m²
//   Arctic tundra (permafrost):                ~10–40 kg/m²
// If values are implausibly low (<1) or high (>200), stop and re-check
// SOTHE_STOCK_BAND and the convFactor before submitting Groups B–D.
exportAsset(ref.stock, 'sothe_stock_kgm2', 'SOC_ref_sothe_stock');
exportAsset(ref.unc,   'sothe_unc_kgm2',   'SOC_ref_sothe_unc');

// ── Group B: Per-comparison-layer outputs ─────────────────────────────────
compResults.forEach(function(cr) {
  var id = cr.layerID;

  exportAsset(cr.stock,                 id + '_stock_kgm2',        'SOC_' + id + '_stock');
  exportAsset(cr.diffs.diff_abs,        id + '_diff_abs_kgm2',     'SOC_' + id + '_diff_abs');
  exportAsset(cr.diffs.diff_rel,        id + '_diff_rel_pct',      'SOC_' + id + '_diff_rel');
  exportAsset(cr.diffs.diff_norm_sothe, id + '_diff_norm_sothe',   'SOC_' + id + '_norm_sothe');

  if (cr.diffs.diff_norm_combined !== null) {
    exportAsset(
      cr.diffs.diff_norm_combined,
      id + '_diff_norm_combined',
      'SOC_' + id + '_norm_combined'
    );
  }
  if (cr.unc !== null) {
    exportAsset(cr.unc, id + '_unc_kgm2', 'SOC_' + id + '_unc');
  }

  // Drive mirrors for rasters intended for local loading in R (terra/tmap).
  // These allow optional spatial visualisation in soc_comparison_analysis.R
  // without requiring rgee.
  exportDrive(cr.diffs.diff_abs, id + '_diff_abs_kgm2',  'SOC_Drive_' + id + '_diff_abs');
  exportDrive(cr.diffs.diff_rel, id + '_diff_rel_pct',   'SOC_Drive_' + id + '_diff_rel');
});

// ── Group C: Masking diagnostic layers ────────────────────────────────────
exportAsset(n_valid,      'n_valid',      'SOC_n_valid');
exportAsset(zero_vs_null, 'zero_vs_null', 'SOC_zero_vs_null');
exportAsset(mask_agree,   'mask_agree',   'SOC_mask_agree');

// ── Group D: Cross-product layers ─────────────────────────────────────────
exportAsset(crossMean,   'cross_mean_kgm2',     'SOC_cross_mean');
exportAsset(crossSD,     'cross_sd_kgm2',       'SOC_cross_sd');
exportAsset(spreadRatio, 'spread_vs_sothe_unc', 'SOC_spread_ratio');

// ── How to submit exports ──────────────────────────────────────────────────
// 1. Click Run in the Code Editor to register all export tasks.
// 2. Open the Tasks tab (top right of the Code Editor).
// 3. Submit Group A tasks first. Click Submit next to each.
// 4. Wait for COMPLETED status before continuing.
// 5. Inspect sothe_stock_kgm2 visually (expected ranges listed above).
// 6. Submit Groups B, C, and D. Tasks are independent and run concurrently.


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — CONSOLE SUMMARY
// Printed at script execution time (before exports run).
// ─────────────────────────────────────────────────────────────────────────────

print('══ SOC COMPARISON — RUN SUMMARY ══');
print('CRS:             EPSG:3978 (Canada Atlas Lambert)');
print('Scale:           250 m');
print('Output unit:     kg/m²');
print('Reference:       Sothe et al. 2022 GBC (0-1m)');
print('  Asset:         ' + SOTHE_STOCK_ASSET + ' [community catalog, no upload]');
print('  Band:          ' + SOTHE_STOCK_BAND + ' [verify in Console]');
print('Analysis mask:   Sothe valid > ' + SOTHE_MIN_THRESHOLD + ' kg/m²');
print('Resampling:      mean aggregation (mass-balance preserving)');
print('Layers loaded:   ' + LAYERS.length);
LAYERS.forEach(function(l) {
  var mode = l.computeOCS ? 'depth-integrated from soc_mean+bdod_mean' :
             l.isCollection ? 'ImageCollection .first()' : 'single Image';
  print('  [' + l.id + ']' +
        '  depth: '       + l.depthInterval +
        '  unc: '         + l.hasUncertainty +
        '  ref: '         + l.isReference +
        '  load: '        + mode);
});
print('SoilGrids bands: CONFIRMED from Charlie\'s Place KBA v4.2');
print('  SOC:  soc_0-5cm_mean … soc_60-100cm_mean  (dg/kg)');
print('  BDOD: bdod_0-5cm_mean … bdod_60-100cm_mean (cg/cm³)');
print('  OCS formula: SOC/10 × BDOD/100 × thickness/100 → kg/m² per layer');
print('Asset root:      ' + ASSET_ROOT);
print('CSV handoff:     GEE_Exports/SOC_zonal_ecozones.csv → R script');
print('Stubs ready:     geng_2025, hengl_2023');
print('══ END SUMMARY ══');

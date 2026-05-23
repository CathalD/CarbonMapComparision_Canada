// ══════════════════════════════════════════════════════════════════════════════
// FOREST CARBON COMPARISON PIPELINE — Google Earth Engine JavaScript
// Spatial comparison of forest carbon map products over Canada
// Reference: Sothe et al. (2022) Global Biogeochemical Cycles
// Canonical grid: 250 m, EPSG:3978 (NAD83 / Canada Atlas Lambert)
//
// Architecture: mirrors soc_comparison_gee.js. The LAYERS array is the single
// extension point — adding a product means adding one descriptor object there.
//
// All asset paths and band names confirmed from Charlie's Place KBA
// Forest Carbon Assessment v4.2 (blue-carbon-hub / north-star-project-470316):
//
//   Sothe FC    projects/sat-io/open-datasets/carbon_stocks_ca/fc
//               ImageCollection → .first() | native kg/m² carbon stock
//
//   SCANFI v1.2 projects/gcpm041u-lemur/assets/scanfi_v12/SCANFI_v1_2
//               Single Image | first band = biomass (Mg/ha, confirmed n[0])
//               'height' band confirmed for CHM cross-check
//
//   SBFI        projects/sat-io/open-datasets/CA_FOREST/CA_SBFI/GRID_forested_ecosystems
//               FeatureCollection → rasterized via reduceToImage()
//               STRUCTURE_AGB_AVG (t/ha) | STRUCTURE_AGB_SD (t/ha)
//
//   GEDI L4A    LARSE/GEDI/GEDI04_A_002_MONTHLY
//               QC: l4_quality_flag == 1 AND degrade_flag == 0
//               agbd (Mg/ha) | agbd_se (Mg/ha, shot-level SE)
//               Coverage: sparse north of ~53°N — see README Section 7
//
// Biomass → carbon conversion (IPCC 2006 Guidelines, boreal forest):
//   Forest C (kg/m²) = AGB (Mg/ha) × (1 + RS) × CF × 0.1
//   RS = IPCC_RS  (root-to-shoot ratio)
//   CF = IPCC_CF  (biomass carbon fraction)
//   0.1 = Mg/ha → kg/m² (1 Mg/ha = 1000 kg / 10,000 m² = 0.1 kg/m²)
//
// Unit check (typical dense boreal forest, AGB = 100 Mg/ha):
//   100 × 1.285 × 0.47 × 0.1 = 6.04 kg C/m² — consistent with Sothe FC range
// ══════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 0 — CONFIG BLOCK
// All user-editable variables are defined here. Nothing is hardcoded elsewhere.
//
// What does NOT need uploading (community catalog, confirmed):
//   SOTHE_FC_ASSET  — sat-io community catalog ImageCollection
//   SCANFI_ASSET    — confirmed asset path from Charlie's Place v4.2
//   SBFI_ASSET      — sat-io community catalog FeatureCollection
//   GEDI            — LARSE collection, no upload
//
// What DOES need uploading / filling in:
//   SOTHE_FC_BAND   — run bandNames() check (see Section 4.1 of README)
//   SOTHE_UNC_ASSET — Sothe uncertainty raster (upload from Zenodo v3.0)
//   SOTHE_UNC_BAND  — band name in uncertainty asset
//   SCANFI_BIOMASS_BAND — run bandNames() to confirm (first band, n[0])
//   GEE_USERNAME    — your GEE username
//   ECOZONES_ASSET  — Canada ecozones FeatureCollection
// ─────────────────────────────────────────────────────────────────────────────

// ── Sothe et al. (2022) — forest carbon ──────────────────────────────────────
// Community catalog ImageCollection. No upload required.
// Run: print(ee.ImageCollection('projects/sat-io/open-datasets/carbon_stocks_ca/fc')
//              .first().bandNames());
var SOTHE_FC_ASSET = 'projects/sat-io/open-datasets/carbon_stocks_ca/fc';
var SOTHE_FC_BAND  = 'VERIFY_BAND_NAME';   // confirm with bandNames() above

// Sothe uncertainty — upload from Zenodo doi:10.4121/16686154.v3
var SOTHE_UNC_ASSET = 'PLACEHOLDER_SOTHE_FC_UNC_ASSET';
var SOTHE_UNC_BAND  = 'PLACEHOLDER_SOTHE_FC_UNC_BAND';

// ── SCANFI v1.2 — National Forest Inventory biomass model ───────────────────
// Asset path confirmed from Charlie's Place v4.2 (Step 2 / Step 4).
// Run: print(ee.Image('projects/gcpm041u-lemur/assets/scanfi_v12/SCANFI_v1_2')
//              .bandNames());
// Expected: first band = aboveground biomass (Mg/ha); 'height' band confirmed.
var SCANFI_ASSET        = 'projects/gcpm041u-lemur/assets/scanfi_v12/SCANFI_v1_2';
var SCANFI_BIOMASS_BAND = 'VERIFY_BIOMASS_BAND';  // first band (n[0]) — confirm name

// ── Canada SBFI — Structured Biomass Forest Inventory ───────────────────────
// FeatureCollection confirmed from Charlie's Place v4.2 (Step 4).
// Properties: STRUCTURE_AGB_AVG (t/ha), STRUCTURE_AGB_SD (t/ha).
var SBFI_ASSET    = 'projects/sat-io/open-datasets/CA_FOREST/CA_SBFI/GRID_forested_ecosystems';
var SBFI_AGB_PROP = 'STRUCTURE_AGB_AVG';
var SBFI_SD_PROP  = 'STRUCTURE_AGB_SD';

// ── GEDI L4A date range ───────────────────────────────────────────────────────
// Same dates used in Charlie's Place v4.2 (Step 3).
var GEDI_START = '2019-04-18';
var GEDI_END   = '2023-12-31';

// ── GEE account and ecozone boundary ─────────────────────────────────────────
var GEE_USERNAME   = 'PLACEHOLDER_GEE_USERNAME';
var ECOZONES_ASSET = 'PLACEHOLDER_ECOZONES_ASSET';

// ── IPCC 2006 biomass-to-carbon conversion factors ───────────────────────────
// Used for SCANFI, SBFI, and GEDI (all reported as AGB biomass density Mg/ha).
// RS: root-to-shoot ratio (IPCC 2006 Table 4.5, boreal forest average).
// CF: carbon fraction of dry biomass (IPCC 2006 Table 4.3, boreal forest).
// Adjust for species-specific estimates if site-level data are available.
var IPCC_RS = 0.285;   // root-to-shoot ratio, boreal forest (Charlie's Place config)
var IPCC_CF = 0.47;    // carbon fraction, boreal forest (IPCC 2006)
// Pre-computed factor: AGB (Mg/ha) → total forest carbon (kg/m²)
// = (1 + RS) × CF × 0.1 = 1.285 × 0.47 × 0.1 = 0.060395 ≈ 0.0604
// Dimensional check: Mg/ha × (unitless) × (unitless) × (kg/m² per Mg/ha) = kg/m²
var BIOMASS_TO_C_KGM2 = (1 + IPCC_RS) * IPCC_CF * 0.1;

// ── Canonical grid ────────────────────────────────────────────────────────────
var CANONICAL_CRS       = 'EPSG:3978';  // NAD83 / Canada Atlas Lambert
var CANONICAL_SCALE     = 250;          // metres
var OUTPUT_UNIT         = 'kg C/m2';    // all raster outputs in this unit
var FOREST_THRESHOLD    = 0.5;
// Minimum Sothe FC value (kg C/m²) below which a pixel is excluded from analysis.
// Prevents comparison artifacts in non-forest, water, and ice pixels.
// Typical bare-ground Sothe FC ≈ 0 kg C/m². Adjust if needed.

var ASSET_ROOT = 'users/' + GEE_USERNAME + '/ForestC_comparison/';

// ── Canada national boundary (confirmed from Charlie's Place v4.2) ────────────
var canada_boundary = ee.FeatureCollection('USDOS/LSIB_SIMPLE/2017')
  .filter(ee.Filter.eq('country_na', 'Canada'));

// ── Startup checks ────────────────────────────────────────────────────────────
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
// Non-fatal warnings for fields needing bandNames() verification.
[
  { k: 'SOTHE_FC_BAND',       v: SOTHE_FC_BAND       },
  { k: 'SCANFI_BIOMASS_BAND', v: SCANFI_BIOMASS_BAND }
].forEach(function(item) {
  if (item.v.indexOf('VERIFY') !== -1) {
    print('⚠ WARNING: ' + item.k + ' is still "' + item.v + '".');
    print('  Run bandNames() check (see script header) before submitting exports.');
  }
});

// ── Print biomass conversion factor for verification ─────────────────────────
print('BIOMASS_TO_C_KGM2 = (1 + ' + IPCC_RS + ') × ' + IPCC_CF + ' × 0.1 = ' +
      BIOMASS_TO_C_KGM2.toFixed(5) + ' kg C/m² per Mg/ha');


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — HARMONIZATION HELPER
// harmonize(image, nativeScaleMetres, layerID)
// For inputs finer than 250 m: mean-aggregates first (mass-balance preserving).
// For inputs coarser than or equal to 250 m: reprojects directly.
// Bilinear resampling is not used — it has no physical justification for stocks.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {ee.Image} image             - Input image (already unit-converted).
 * @param {number}   nativeScaleMetres - Native pixel size in metres.
 * @param {string}   layerID           - Short label for console messages.
 * @returns {ee.Image} Image at CANONICAL_CRS / CANONICAL_SCALE.
 */
function harmonize(image, nativeScaleMetres, layerID) {
  if (nativeScaleMetres < CANONICAL_SCALE) {
    print(layerID + ': aggregated from ' + nativeScaleMetres + 'm to 250m via mean');
    return image
      .reduceResolution({ reducer: ee.Reducer.mean(), bestEffort: false, maxPixels: 1024 })
      .reproject({ crs: CANONICAL_CRS, scale: CANONICAL_SCALE });
  } else {
    print(layerID + ': reprojected to 250m (native >= 250m)');
    return image.reproject({ crs: CANONICAL_CRS, scale: CANONICAL_SCALE });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — LAYER REGISTRY
// LAYERS is the single extension point. Adding a product means adding one
// descriptor object here — no other changes needed in the script.
//
// Standard fields (all layers):
//   id, citation, nativeUnit, convFactor, convNote,
//   nativeScale, hasUncertainty, isReference, spatialExtent
//
// Load-mode fields (one set per mode):
//   isCollection : true  → ImageCollection, take .first()  (Sothe FC)
//   isVector     : true  → FeatureCollection, rasterize    (SBFI)
//   computeGEDI  : true  → build L4A composite inline      (GEDI)
//   default (none of above) → single ee.Image              (SCANFI)
//
// Asset fields (mode-dependent):
//   assetPath   : image or collection GEE path
//   bandName    : band to select (Image / Collection modes)
//   vectorProp  : property to rasterize (Vector mode)
//   vectorSdProp: SD property for uncertainty (Vector mode)
// ─────────────────────────────────────────────────────────────────────────────

var LAYERS = [

  // ── REFERENCE LAYER — Sothe et al. (2022) forest carbon ─────────────────
  // Community catalog ImageCollection, no upload required.
  // Product represents total forest carbon stock (AGB + BGB carbon, kg/m²).
  // Verify native band name before running:
  //   print(ee.ImageCollection(SOTHE_FC_ASSET).first().bandNames());
  {
    id:             'sothe_fc',
    citation:       'Sothe et al. (2022), Global Biogeochemical Cycles, ' +
                    '36, e2021GB007213. doi:10.1029/2021GB007213. ' +
                    'Dataset v3.0: doi:10.4121/16686154.v3. ' +
                    'Community catalog: projects/sat-io/open-datasets/carbon_stocks_ca/',
    assetPath:      SOTHE_FC_ASSET,
    bandName:       SOTHE_FC_BAND,
    isCollection:   true,      // load as ImageCollection, take .first()
    nativeUnit:     'kg C/m²',
    convFactor:     1,
    // kg C/m² × 1.0 = kg C/m²   [Native unit matches output — no conversion]
    convNote:       'Native unit is kg C/m² — no conversion required.',
    nativeScale:    250,
    hasUncertainty: true,
    uncAssetPath:   SOTHE_UNC_ASSET,
    uncBandName:    SOTHE_UNC_BAND,
    uncConvFactor:  1,
    // kg C/m² × 1.0 = kg C/m²   [Native unit — no conversion]
    isReference:    true,
    spatialExtent:  'Canada (wall-to-wall)'
  },

  // ── COMPARISON LAYER 1 — SCANFI v1.2 ─────────────────────────────────────
  // Asset path and first-band-is-biomass confirmed from Charlie's Place v4.2
  // Step 2 (import raster priors) and Step 4 (covariate stack).
  // Units confirmed as Mg/ha from vis params (min:0, max:200) in Charlie's Place.
  // 'height' band also confirmed (used in CHM comparison in Step 3).
  //
  // BAND VERIFICATION — run in a new GEE script:
  //   print(ee.Image('projects/gcpm041u-lemur/assets/scanfi_v12/SCANFI_v1_2')
  //           .bandNames());
  // Expected: first band (n[0]) is aboveground biomass; 'height' is canopy height.
  // Update SCANFI_BIOMASS_BAND once confirmed.
  //
  // Note on SCANFI carbon pools: SCANFI reports aboveground biomass only.
  // Belowground biomass is estimated via IPCC root-to-shoot ratio (RS = 0.285).
  // Compare with Sothe FC (AGB+BGB carbon) requires both pools.
  {
    id:             'scanfi',
    citation:       'Matasci et al. (2018), Remote Sensing of Environment, ' +
                    '209:90-101. doi:10.1016/j.rse.2017.12.020. ' +
                    'SCANFI v1.2: Hermosilla et al. (2022). ' +
                    'GEE asset: projects/gcpm041u-lemur/assets/scanfi_v12/SCANFI_v1_2',
    assetPath:      SCANFI_ASSET,
    bandName:       SCANFI_BIOMASS_BAND,    // first band (n[0]); confirm with bandNames()
    isCollection:   false,
    nativeUnit:     'Mg/ha (aboveground biomass)',
    convFactor:     BIOMASS_TO_C_KGM2,
    // Mg/ha × BIOMASS_TO_C_KGM2 = kg C/m²
    // = AGB × (1 + RS) × CF × 0.1
    // = AGB × 1.285 × 0.47 × 0.1 = AGB × 0.0604 kg C/m²
    // Includes belowground via IPCC root-to-shoot ratio (RS=0.285, IPCC 2006).
    convNote:       'Mg/ha × (1+0.285) × 0.47 × 0.1 → kg C/m². ' +
                    'IPCC RS=0.285 (boreal), CF=0.47 (boreal forest, IPCC 2006 Table 4.3)',
    nativeScale:    250,
    hasUncertainty: false,
    // SCANFI v1.2 does not provide formal pixel-level uncertainty. The NFI
    // k-NN method has plot-level RMSE but no per-pixel spatial uncertainty.
    // Set hasUncertainty: true and add uncAssetPath if an uncertainty layer
    // becomes available in the community catalog.
    uncAssetPath:   null,
    uncBandName:    null,
    uncConvFactor:  null,
    isReference:    false,
    spatialExtent:  'Canada (national, forest lands)'
  },

  // ── COMPARISON LAYER 2 — Canada SBFI ─────────────────────────────────────
  // FeatureCollection asset path confirmed from Charlie's Place v4.2 Step 4.
  // Properties STRUCTURE_AGB_AVG and STRUCTURE_AGB_SD confirmed from the same.
  // Grid cells are ~2 km × 2 km; rasterized to 250 m via reduceToImage().
  //
  // SBFI uncertainty note: STRUCTURE_AGB_SD is the within-grid-cell spatial
  // variability of AGB (t/ha), not formal prediction uncertainty. It is used
  // here as a proxy for local inventory variability. Treat diff_norm_combined
  // values cautiously — the SD likely underestimates true prediction error.
  {
    id:             'sbfi',
    citation:       'Beaudoin et al. (2017), Canadian Journal of Forest Research. ' +
                    'doi:10.1139/cjfr-2016-0184. ' +
                    'GEE community catalog: projects/sat-io/open-datasets/CA_FOREST/CA_SBFI/',
    // isVector:true activates rasterization in loadLayer() using vectorProp.
    assetPath:      SBFI_ASSET,
    bandName:       null,         // not used for vector mode
    isVector:       true,
    vectorProp:     SBFI_AGB_PROP,   // 'STRUCTURE_AGB_AVG', confirmed from Charlie's Place
    vectorSdProp:   SBFI_SD_PROP,    // 'STRUCTURE_AGB_SD',  confirmed from Charlie's Place
    nativeUnit:     't/ha (= Mg/ha aboveground biomass)',
    convFactor:     BIOMASS_TO_C_KGM2,
    // t/ha × BIOMASS_TO_C_KGM2 = kg C/m²   [1 t/ha = 1 Mg/ha → same factor as SCANFI]
    convNote:       't/ha × (1+0.285) × 0.47 × 0.1 → kg C/m². ' +
                    'IPCC RS=0.285 (boreal), CF=0.47 (IPCC 2006). ' +
                    '(1 t/ha = 1 Mg/ha — same conversion factor as SCANFI)',
    nativeScale:    2000,   // ~2 km SBFI grid cells; reprojected to 250 m
    hasUncertainty: true,
    uncAssetPath:   SBFI_ASSET,
    uncBandName:    null,     // SD derived from vectorSdProp in loadLayer()
    uncConvFactor:  BIOMASS_TO_C_KGM2,
    // t/ha SD × BIOMASS_TO_C_KGM2 = kg C/m² SD  [same conversion as stock]
    isReference:    false,
    spatialExtent:  'Canada forested lands (inventory grid coverage)'
  },

  // ── COMPARISON LAYER 3 — GEDI L4A composite ──────────────────────────────
  // GEDI L4A monthly collection confirmed from Charlie's Place v4.2 Step 3.
  // QC filters (l4_quality_flag==1, degrade_flag==0) confirmed from same.
  // agbd and agbd_se bands confirmed. Units: Mg/ha.
  //
  // IMPORTANT COVERAGE NOTE: GEDI's orbital coverage reaches to ~52–55°N.
  // Most of Canada's boreal and all subarctic forest is NOT covered.
  // n_valid will show where GEDI data exists. Zonal comparisons in northern
  // ecozones will have very few or zero valid GEDI pixels — do not interpret.
  //
  // computeGEDI:true activates inline composite construction in loadLayer().
  // Uncertainty uses median(agbd_se) — shot-level SE, not composite prediction
  // uncertainty. Values represent observational precision, not model error.
  {
    id:             'gedi_l4a',
    citation:       'Duncanson et al. (2022), Science of Remote Sensing, ' +
                    '5:100035. doi:10.1016/j.srs.2021.100035. ' +
                    'GEDI L4A MONTHLY: LARSE/GEDI/GEDI04_A_002_MONTHLY',
    assetPath:      'LARSE/GEDI/GEDI04_A_002_MONTHLY',
    bandName:       'agbd',                // confirmed from Charlie's Place Step 3
    isCollection:   false,
    computeGEDI:    true,                  // activates composite building in loadLayer()
    nativeUnit:     'Mg/ha (aboveground biomass density)',
    convFactor:     BIOMASS_TO_C_KGM2,
    // Mg/ha × BIOMASS_TO_C_KGM2 = kg C/m²   [same as SCANFI]
    convNote:       'Mg/ha × (1+0.285) × 0.47 × 0.1 → kg C/m². ' +
                    'IPCC RS=0.285 (boreal), CF=0.47 (IPCC 2006). ' +
                    'Coverage north of ~53°N is sparse — see README Section 7.',
    nativeScale:    25,   // GEDI shots at ~25 m footprint; median composite ~25 m
    hasUncertainty: true,
    uncAssetPath:   'LARSE/GEDI/GEDI04_A_002_MONTHLY',
    uncBandName:    'agbd_se',             // confirmed from Charlie's Place Step 3
    uncConvFactor:  BIOMASS_TO_C_KGM2,
    // agbd_se (Mg/ha) × factor = kg C/m² SE. Note: shot-level SE, not composite.
    isReference:    false,
    spatialExtent:  'Canada south of ~53°N only (GEDI orbital coverage limit)'
  }

];  // end LAYERS


// ── FUTURE LAYER STUBS (commented out) ──────────────────────────────────────
/*

  // Canopy height models — optional cross-validation layer
  // These provide canopy height (m), not carbon stock. Include as a diagnostic
  // after confirming that height → carbon allometrics are available.
  //
  // Sothe Canopy Height Model (confirmed from Charlie's Place Step 3):
  // {
  //   id:          'sothe_ch',
  //   assetPath:   'projects/sat-io/open-datasets/carbon_stocks_ca/ch',
  //   isCollection: true,     // same as FC — take .first(), select band [0]
  //   bandName:    'VERIFY_BAND_NAME',
  //   nativeUnit:  'm (canopy height)',
  //   // Requires height-to-biomass allometric for carbon comparison.
  // },
  //
  // Meta/Facebook Canopy Height Model (confirmed from Charlie's Place Step 3):
  // {
  //   id:          'meta_ch',
  //   assetPath:   'projects/sat-io/open-datasets/facebook/meta-canopy-height',
  //   isCollection: true,
  //   bandName:    'VERIFY_BAND_NAME',
  //   nativeUnit:  'm (canopy height)',
  // }

*/


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — LOAD, CONVERT, AND HARMONIZE
// loadLayer(layerDef) → { stock: ee.Image, unc: ee.Image|null, def: Object }
//
// Four load modes:
//   A. isCollection: true  → ImageCollection .first()  (Sothe FC)
//   B. isVector: true      → FeatureCollection rasterized via reduceToImage()  (SBFI)
//   C. computeGEDI: true   → GEDI L4A monthly composite with QC  (GEDI)
//   D. default             → single ee.Image  (SCANFI, future layers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load a layer descriptor: apply unit conversion, harmonize to canonical grid,
 * and optionally derive uncertainty.
 * @param {Object} layerDef - One descriptor object from the LAYERS array.
 * @returns {{ stock: ee.Image, unc: ee.Image|null, def: Object }}
 */
function loadLayer(layerDef) {
  var stock, unc;

  // ── Mode C: GEDI L4A — build composite inline ────────────────────────────
  if (layerDef.computeGEDI === true) {

    // Build QC-filtered monthly composite over Canada.
    // QC logic confirmed from Charlie's Place v4.2 Step 3.
    var gediRaw = ee.ImageCollection(layerDef.assetPath)
      .filterDate(GEDI_START, GEDI_END)
      .filterBounds(canada_boundary)
      .map(function(img) {
        var qc = img.select('l4_quality_flag').eq(1)
                    .and(img.select('degrade_flag').eq(0));
        // l4_quality_flag == 1: good quality AGBD prediction
        // degrade_flag == 0: no data quality degradation flag
        return img.select(['agbd', 'agbd_se']).updateMask(qc);
      });

    gediRaw.size().evaluate(function(n) {
      print('GEDI L4A monthly images loaded (Canada buffer): ' + n);
      print('  Date range: ' + GEDI_START + ' to ' + GEDI_END);
      print('  Note: coverage is sparse north of ~53°N (orbital limit).');
    });

    // Mg/ha × BIOMASS_TO_C_KGM2 = kg C/m²
    stock = gediRaw.select('agbd').median()
      .multiply(layerDef.convFactor)
      .rename(layerDef.id + '_kgm2');
    stock = harmonize(stock, layerDef.nativeScale, layerDef.id);

    // Uncertainty: median of shot-level agbd_se (Mg/ha) → kg C/m²
    // This represents observational precision, not composite prediction error.
    unc = gediRaw.select('agbd_se').median()
      .multiply(layerDef.uncConvFactor)
      .rename(layerDef.id + '_unc_kgm2');
    unc = harmonize(unc, layerDef.nativeScale, layerDef.id + '_unc');

    return { stock: stock, unc: unc, def: layerDef };
  }

  // ── Mode B: Vector FeatureCollection — rasterize to image ────────────────
  if (layerDef.isVector === true) {

    var vectorFC = ee.FeatureCollection(layerDef.assetPath);

    // Print property inventory to confirm column names before use.
    vectorFC.first().propertyNames().evaluate(function(props) {
      print('SBFI FeatureCollection — available properties:', props);
      if (props.indexOf(layerDef.vectorProp) === -1) {
        print('⚠ WARNING: vectorProp "' + layerDef.vectorProp +
              '" not found. Update SBFI_AGB_PROP in Section 0.');
      }
    });

    // Rasterize AGB average.
    // Approach confirmed from Charlie's Place v4.2 Step 4 (sbfi_avg_img).
    // reduceToImage + first() is appropriate: grid cells are non-overlapping.
    var rawStock = vectorFC
      .filter(ee.Filter.notNull([layerDef.vectorProp]))
      .reduceToImage({
        properties: [layerDef.vectorProp],
        reducer:    ee.Reducer.first()
      })
      .rename('raw_stock');

    // t/ha × BIOMASS_TO_C_KGM2 = kg C/m²   [1 t/ha = 1 Mg/ha, same factor]
    stock = rawStock.multiply(layerDef.convFactor)
      .rename(layerDef.id + '_kgm2');
    stock = harmonize(stock, layerDef.nativeScale, layerDef.id);

    // Rasterize AGB SD for uncertainty.
    // SD is within-grid variability (t/ha), not formal prediction error.
    unc = null;
    if (layerDef.hasUncertainty && layerDef.vectorSdProp) {
      var rawSD = vectorFC
        .filter(ee.Filter.notNull([layerDef.vectorSdProp]))
        .reduceToImage({
          properties: [layerDef.vectorSdProp],
          reducer:    ee.Reducer.first()
        })
        .rename('raw_sd');
      // t/ha SD × BIOMASS_TO_C_KGM2 = kg C/m² SD
      unc = rawSD.multiply(layerDef.uncConvFactor)
        .rename(layerDef.id + '_unc_kgm2');
      unc = harmonize(unc, layerDef.nativeScale, layerDef.id + '_unc');
    }

    return { stock: stock, unc: unc, def: layerDef };
  }

  // ── Mode A: ImageCollection — take first image ────────────────────────────
  if (layerDef.isCollection === true) {

    var col = ee.ImageCollection(layerDef.assetPath);

    // Print band names at load time for bandName verification.
    col.first().bandNames().evaluate(function(bands) {
      print(layerDef.id + ' — available bands:', bands);
      if (layerDef.bandName.indexOf('VERIFY') === -1 &&
          bands.indexOf(layerDef.bandName) === -1) {
        print('⚠ WARNING: band "' + layerDef.bandName + '" not found in ' +
              layerDef.id + '. Update band name in CONFIG or LAYERS registry.');
      }
    });

    stock = col.first()
      .select(layerDef.bandName)
      // [nativeUnit] × convFactor = kg C/m²
      .multiply(layerDef.convFactor)
      .rename(layerDef.id + '_kgm2');
    stock = harmonize(stock, layerDef.nativeScale, layerDef.id);

    // Uncertainty from a separate asset (Sothe uncertainty).
    unc = null;
    if (layerDef.hasUncertainty && layerDef.uncAssetPath && layerDef.uncBandName) {
      unc = ee.Image(layerDef.uncAssetPath)
        .select(layerDef.uncBandName)
        // [nativeUnit] × uncConvFactor = kg C/m²
        .multiply(layerDef.uncConvFactor)
        .rename(layerDef.id + '_unc_kgm2');
      unc = harmonize(unc, layerDef.nativeScale, layerDef.id + '_unc');
    }

    return { stock: stock, unc: unc, def: layerDef };
  }

  // ── Mode D: standard single ee.Image (default) ────────────────────────────
  // Used for SCANFI and any future single-Image layers.

  var img = ee.Image(layerDef.assetPath);

  // Print band names at load time for bandName verification.
  img.bandNames().evaluate(function(bands) {
    print(layerDef.id + ' — available bands:', bands);
    if (layerDef.bandName.indexOf('VERIFY') === -1 &&
        bands.indexOf(layerDef.bandName) === -1) {
      print('⚠ WARNING: band "' + layerDef.bandName + '" not found. ' +
            'Update bandName in LAYERS registry.');
    }
    if (bands.length > 1) {
      print('  (Note: multiple bands available — using: ' + layerDef.bandName + ')');
    }
  });

  stock = img.select(layerDef.bandName)
    // [nativeUnit] × convFactor = kg C/m²
    .multiply(layerDef.convFactor)
    .rename(layerDef.id + '_kgm2');
  stock = harmonize(stock, layerDef.nativeScale, layerDef.id);

  unc = null;
  if (layerDef.hasUncertainty && layerDef.uncAssetPath && layerDef.uncBandName) {
    unc = ee.Image(layerDef.uncAssetPath)
      .select(layerDef.uncBandName)
      .multiply(layerDef.uncConvFactor)
      .rename(layerDef.id + '_unc_kgm2');
    unc = harmonize(unc, layerDef.nativeScale, layerDef.id + '_unc');
  }

  return { stock: stock, unc: unc, def: layerDef };
}

// ── Separate reference layer from comparison layers ───────────────────────
var ref = null;
var compLayers = [];

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
// Primary mask: based on Sothe FC stock > FOREST_THRESHOLD.
// This restricts analysis to forested pixels as defined by Sothe.
// Non-forest pixels (agriculture, water, tundra, ice) are excluded.
// ─────────────────────────────────────────────────────────────────────────────

// Primary analysis mask — all difference outputs are clipped to this.
var refMask = ref.stock.gt(FOREST_THRESHOLD).selfMask();
// Excludes non-forest, water, ice, and bare-rock pixels where Sothe FC
// is at or below the forest threshold. Prevents comparison artifacts in
// pixels where some products may show non-zero biomass (e.g. shrub tundra)
// but Sothe defines as non-forest.

// ── 4a: n_valid — per-pixel count of layers with valid data ──────────────
// Includes Sothe FC. Range: 1 (only Sothe) to N (all layers present).
// GEDI will show n_valid < N north of ~53°N due to orbital coverage limits.
var allStocks = [ref.stock].concat(
  compLayers.map(function(c) { return c.stock; })
);
var n_valid = ee.ImageCollection.fromImages(allStocks).count().rename('n_valid');

// ── 4b: zero_vs_null — per-layer data status ─────────────────────────────
// Class 0 = masked (no data)
// Class 1 = valid value > 0 (forest with carbon estimated)
// Class 2 = unmasked but value exactly 0 (explicit zero, e.g. post-harvest)
// Critical distinction: SBFI masks cells with no inventory coverage (class 0)
// vs. cells with measured but zero AGB (class 2, clearcut or burned).
var zvnBands = allStocks.map(function(img) {
  var bandLabel = img.bandNames().get(0);
  var valid   = img.gt(0).unmask(0);
  var isZero  = img.eq(0).unmask(0);
  var notNull = img.mask().unmask(0);
  return valid.add(isZero.multiply(2).multiply(notNull))
              .rename(ee.String(bandLabel).cat('_zvn'));
});
var zero_vs_null = ee.Image.cat(zvnBands);

// ── 4c: mask_agreement — pixels where ALL layers have valid data ──────────
var totalLayerCount = LAYERS.length;
var mask_agree = n_valid.eq(totalLayerCount).rename('mask_agree').selfMask();
// With GEDI included, mask_agree will exclude most of Canada north of 53°N.
// For national analyses, consider computing mask_agree excluding GEDI
// (n_valid >= 3 for Sothe + SCANFI + SBFI).

// ── 4d: Optional — mask_agree without GEDI (for Canada-wide summaries) ───
// Useful for zonal stats that should not be dominated by GEDI coverage gaps.
var mask_agree_no_gedi = n_valid.gte(totalLayerCount - 1)
  .rename('mask_agree_no_gedi').selfMask();
// This requires Sothe + SCANFI + SBFI to all be valid, ignoring GEDI coverage.


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — DIFFERENCE RASTERS
// computeDifferences(compResult, refResult) → object of named ee.Images
// Same structure as soc_comparison_gee.js. All outputs in kg C/m².
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} compResult - { stock, unc, def } for comparison layer.
 * @param {Object} refResult  - { stock, unc, def } for reference layer.
 * @returns {Object} Named ee.Image outputs.
 */
function computeDifferences(compResult, refResult) {
  var layerID = compResult.def.id;
  var comp    = compResult.stock;
  var refImg  = refResult.stock;

  // ── 5a: Absolute difference (kg C/m², signed) ─────────────────────────
  // Positive = comparison layer estimates MORE forest carbon than Sothe.
  var diff_abs = comp.subtract(refImg)
    .updateMask(refMask)
    .rename(layerID + '_diff_abs_kgm2');

  // ── 5b: Relative difference (%, signed) ─────────────────────────────────
  // Masked where Sothe FC < FOREST_THRESHOLD (non-forest pixels already
  // excluded by refMask, so the denominator guard is belt-and-suspenders).
  var diff_rel = comp.subtract(refImg)
    .divide(refImg.max(FOREST_THRESHOLD))
    .multiply(100)
    .updateMask(refMask)
    .updateMask(refImg.gt(FOREST_THRESHOLD))
    .rename(layerID + '_diff_rel_pct');

  // ── 5c: Uncertainty-normalized — Sothe uncertainty only ─────────────────
  // |value| > 1 = disagreement exceeds Sothe 1-sigma. Minimum uncertainty-
  // aware test; does not account for comparison layer uncertainty.
  var diff_norm_sothe = comp.subtract(refImg)
    .divide(refResult.unc)
    .updateMask(refMask)
    .updateMask(refResult.unc.gt(0))
    .rename(layerID + '_diff_norm_sothe');

  var result = {
    diff_abs:           diff_abs,
    diff_rel:           diff_rel,
    diff_norm_sothe:    diff_norm_sothe,
    diff_norm_combined: null
  };

  // ── 5c continued: combined uncertainty ───────────────────────────────────
  // Available only if comparison layer has formal uncertainty.
  // SCANFI: skipped (no uncertainty). SBFI: within-cell SD (proxy).
  // GEDI: shot-level SE (underestimates true composite uncertainty).
  // |value| > 2 = high-priority field validation target.
  if (compResult.unc !== null) {
    var combinedUnc = refResult.unc.pow(2).add(compResult.unc.pow(2)).sqrt();
    result.diff_norm_combined = comp.subtract(refImg)
      .divide(combinedUnc)
      .updateMask(refMask)
      .updateMask(combinedUnc.gt(0))
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
// Ensemble spread across all comparison layers (SCANFI, SBFI, GEDI).
// ─────────────────────────────────────────────────────────────────────────────

var compCollection = ee.ImageCollection.fromImages(
  compLayers.map(function(c) { return c.stock; })
);

// ── 6a: Cross-product mean (kg C/m²) ──────────────────────────────────────
var crossMean = compCollection.mean().updateMask(refMask).rename('cross_mean_kgm2');

// ── 6b: Cross-product standard deviation — ensemble spread (kg C/m²) ──────
// With N=3 layers (SCANFI + SBFI + GEDI) this is a meaningful spread metric.
// Drops to N=2 in regions without GEDI coverage (northern Canada).
var crossSD = compCollection.reduce(ee.Reducer.stdDev())
  .updateMask(refMask).rename('cross_sd_kgm2');

// ── 6c: Spread-to-Sothe-uncertainty ratio (dimensionless) ─────────────────
// Values > 1 = cross-product disagreement exceeds Sothe's reported uncertainty.
// Spatial hotspots identify areas where additional forest inventory or
// airborne LiDAR campaigns would most reduce mapping uncertainty.
var spreadRatio = crossSD.divide(ref.unc)
  .updateMask(refMask)
  .updateMask(ref.unc.gt(0))
  .rename('spread_vs_sothe_unc');

// ── 6d: SCANFI-SBFI agreement (kg C/m²) — independent of GEDI ────────────
// Both products rely on NFI plot data; their disagreement reflects methodological
// differences in spatial interpolation, not GEDI orbital coverage gaps.
var scanfiStock = compLayers.filter(function(c) { return c.def.id === 'scanfi'; })[0];
var sbfiStock   = compLayers.filter(function(c) { return c.def.id === 'sbfi';   })[0];

var scanfi_sbfi_diff = null;
if (scanfiStock && sbfiStock) {
  scanfi_sbfi_diff = scanfiStock.stock.subtract(sbfiStock.stock)
    .updateMask(refMask)
    .rename('scanfi_minus_sbfi_kgm2');
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — ZONAL SUMMARY TABLE
// Per-ecozone statistics over all difference bands.
// CSV export → handoff to forest_carbon_comparison_analysis.R
// ─────────────────────────────────────────────────────────────────────────────

var ecozones = ee.FeatureCollection(ECOZONES_ASSET);
// Fallback (uncomment if ECOZONES_ASSET is not yet available):
// var ecozones = ee.FeatureCollection('RESOLVE/ECOREGIONS/2017')
//                 .filter(ee.Filter.bounds(canada_boundary));

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

diffBandImages.push(ref.stock);
diffBandImages.push(ref.unc);
diffBandImages.push(crossMean);
diffBandImages.push(crossSD);
diffBandImages.push(spreadRatio);
diffBandImages.push(n_valid);
if (scanfi_sbfi_diff !== null) {
  diffBandImages.push(scanfi_sbfi_diff);
}

var stackedDiffs = ee.Image.cat(diffBandImages);

// tileScale: 4 required at Canada-wide 250 m to avoid memory errors.
var zonalResult = stackedDiffs.reduceRegions({
  collection: ecozones,
  reducer:    ee.Reducer.mean()
              .combine(ee.Reducer.median(),             '', true)
              .combine(ee.Reducer.stdDev(),             '', true)
              .combine(ee.Reducer.percentile([10, 90]), '', true),
  scale:      CANONICAL_SCALE,
  crs:        CANONICAL_CRS,
  tileScale:  4
});

Export.table.toAsset({
  collection:  zonalResult,
  description: 'ForestC_zonal_ecozones',
  assetId:     ASSET_ROOT + 'ForestC_zonal_ecozones'
});

// CSV export — primary handoff to forest_carbon_comparison_analysis.R
Export.table.toDrive({
  collection:     zonalResult,
  description:    'ForestC_zonal_ecozones_csv',
  folder:         'GEE_Exports',
  fileNamePrefix: 'ForestC_zonal_ecozones',
  fileFormat:     'CSV'
});


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — ASSET EXPORT PIPELINE
// Same helper structure as soc_comparison_gee.js.
// ─────────────────────────────────────────────────────────────────────────────

function exportAsset(image, shortName, description) {
  Export.image.toAsset({
    image:       image,
    description: description,
    assetId:     ASSET_ROOT + shortName,
    crs:         CANONICAL_CRS,
    scale:       CANONICAL_SCALE,
    maxPixels:   1e13,
    region:      canada_boundary.geometry()
  });
}

function exportDrive(image, fileName, description) {
  Export.image.toDrive({
    image:          image,
    description:    description,
    folder:         'GEE_Exports',
    fileNamePrefix: fileName,
    crs:            CANONICAL_CRS,
    scale:          CANONICAL_SCALE,
    maxPixels:      1e13,
    region:         canada_boundary.geometry(),
    fileFormat:     'GeoTIFF'
  });
}

// ── Group A: Reference verification — SUBMIT FIRST ───────────────────────
// Expected values for Sothe FC (forest carbon, kg C/m²):
//   Dense boreal conifer (northern Ontario, Quebec):  8–15 kg C/m²
//   Temperate/montane forest (BC interior):           5–12 kg C/m²
//   Boreal mixedwood (Alberta, Saskatchewan):          4–10 kg C/m²
//   Recent clearcut or burned:                        0.5–2 kg C/m²
// If values are implausibly low (<0.5 across forested areas) or very high
// (>30), stop and verify SOTHE_FC_BAND before submitting Groups B–D.
exportAsset(ref.stock, 'sothe_fc_kgm2', 'ForestC_ref_sothe_stock');
exportAsset(ref.unc,   'sothe_fc_unc_kgm2', 'ForestC_ref_sothe_unc');

// ── Group B: Per-comparison-layer outputs ─────────────────────────────────
compResults.forEach(function(cr) {
  var id = cr.layerID;
  exportAsset(cr.stock,                 id + '_stock_kgm2',      'ForestC_' + id + '_stock');
  exportAsset(cr.diffs.diff_abs,        id + '_diff_abs_kgm2',   'ForestC_' + id + '_diff_abs');
  exportAsset(cr.diffs.diff_rel,        id + '_diff_rel_pct',    'ForestC_' + id + '_diff_rel');
  exportAsset(cr.diffs.diff_norm_sothe, id + '_diff_norm_sothe', 'ForestC_' + id + '_norm_sothe');
  if (cr.diffs.diff_norm_combined !== null) {
    exportAsset(cr.diffs.diff_norm_combined, id + '_diff_norm_combined',
                'ForestC_' + id + '_norm_combined');
  }
  if (cr.unc !== null) {
    exportAsset(cr.unc, id + '_unc_kgm2', 'ForestC_' + id + '_unc');
  }
  // Drive mirrors for optional local loading in R (terra/tmap).
  exportDrive(cr.diffs.diff_abs, id + '_diff_abs_kgm2', 'ForestC_Drive_' + id + '_diff_abs');
  exportDrive(cr.diffs.diff_rel, id + '_diff_rel_pct',  'ForestC_Drive_' + id + '_diff_rel');
});

// ── Group C: Masking and diagnostic layers ────────────────────────────────
exportAsset(n_valid,             'n_valid',             'ForestC_n_valid');
exportAsset(zero_vs_null,        'zero_vs_null',        'ForestC_zero_vs_null');
exportAsset(mask_agree,          'mask_agree',          'ForestC_mask_agree');
exportAsset(mask_agree_no_gedi,  'mask_agree_no_gedi',  'ForestC_mask_agree_no_gedi');

// ── Group D: Cross-product layers ─────────────────────────────────────────
exportAsset(crossMean,   'cross_mean_kgm2',       'ForestC_cross_mean');
exportAsset(crossSD,     'cross_sd_kgm2',          'ForestC_cross_sd');
exportAsset(spreadRatio, 'spread_vs_sothe_unc',    'ForestC_spread_ratio');
if (scanfi_sbfi_diff !== null) {
  exportAsset(scanfi_sbfi_diff, 'scanfi_minus_sbfi_kgm2', 'ForestC_scanfi_sbfi_diff');
}

// ── How to submit exports ──────────────────────────────────────────────────
// 1. Click Run to register all tasks. Check console for warnings.
// 2. Submit Group A first. Verify sothe_fc_kgm2 against expected ranges above.
// 3. Submit Groups B, C, D — tasks run concurrently in GEE queue.
// 4. GEDI composite (gedi_l4a tasks in Group B) may take longer than others
//    due to the large ImageCollection filter over Canada. This is normal.


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — CONSOLE SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

print('══ FOREST CARBON COMPARISON — RUN SUMMARY ══');
print('CRS:              EPSG:3978 (Canada Atlas Lambert)');
print('Scale:            250 m');
print('Output unit:      kg C/m²');
print('Reference:        Sothe et al. 2022 GBC (forest carbon)');
print('  Asset:          ' + SOTHE_FC_ASSET + ' [community catalog, no upload]');
print('  Band:           ' + SOTHE_FC_BAND + ' [verify in Console]');
print('Forest mask:      Sothe FC > ' + FOREST_THRESHOLD + ' kg C/m²');
print('Resampling:       mean aggregation (mass-balance preserving)');
print('IPCC factors:     RS=' + IPCC_RS + '  CF=' + IPCC_CF);
print('Biomass→C factor: ' + BIOMASS_TO_C_KGM2.toFixed(5) + ' kg C/m² per Mg/ha');
print('Layers loaded:    ' + LAYERS.length);
LAYERS.forEach(function(l) {
  var mode = l.computeGEDI ? 'GEDI composite' :
             l.isVector    ? 'vector rasterized' :
             l.isCollection? 'ImageCollection .first()' : 'single Image';
  print('  [' + l.id + ']' +
        '  unit: '  + l.nativeUnit +
        '  unc: '   + l.hasUncertainty +
        '  ref: '   + l.isReference +
        '  mode: '  + mode);
});
print('SCANFI bands:     VERIFY — first band (n[0]) is biomass | "height" confirmed');
print('SBFI props:       STRUCTURE_AGB_AVG / STRUCTURE_AGB_SD — CONFIRMED');
print('GEDI QC:          l4_quality_flag==1 AND degrade_flag==0 — CONFIRMED');
print('Asset root:       ' + ASSET_ROOT);
print('CSV handoff:      GEE_Exports/ForestC_zonal_ecozones.csv → R script');
print('⚠ GEDI coverage: sparse north of ~53°N — see README Section 7');
print('══ END SUMMARY ══');

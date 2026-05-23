# SOC Map Spatial Comparison Pipeline — Canada

A reproducible pipeline for comparing soil organic carbon (SOC) map products
across Canada at 250 m resolution, using Google Earth Engine (GEE) for raster
operations and R for statistical analysis and figures.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Uploading Local Rasters to GEE](#3-uploading-local-rasters-to-gee)
4. [Running the GEE Script](#4-running-the-gee-script)
5. [Running the R Script](#5-running-the-r-script)
6. [Adding a New Layer](#6-adding-a-new-layer)
7. [Known Limitations and Caveats](#7-known-limitations-and-caveats)
8. [File Structure](#8-file-structure)

---

## 1. Overview

### What this pipeline does

This pipeline performs a spatial intercomparison of two soil organic carbon
(SOC) map products over the full extent of Canada:

- **Sothe et al. (2022)** — used as the spatial reference layer (0–1 m stock,
  kg/m², wall-to-wall Canada coverage)
- **SoilGrids v2 (Poggio et al. 2021)** — compared against Sothe

Both products are harmonized to a common 250 m grid in the
**NAD83 / Canada Atlas Lambert (EPSG:3978)** projection. Outputs include
signed absolute and relative difference rasters, uncertainty-normalized
difference maps, cross-product spread analysis, and per-ecozone zonal
statistics.

The pipeline is structured to be extensible: two additional products
(Geng et al. 2025 and Hengl et al. 2023) are pre-configured as commented
stubs and can be activated with minimal effort.

### Architecture: why the hybrid GEE + R split

| Component | Tool | Reason |
|-----------|------|--------|
| Raster harmonization, masking, difference maps, zonal statistics | GEE JavaScript | Canada-wide 250 m rasters are too large for local machines. GEE processes them on Google's servers at no cost to the user. |
| Statistical summaries, Bland-Altman plots, ecozone figures, heatmaps | R (`terra`, `ggplot2`, `tmap`) | R provides superior statistical tooling and publication-quality figures. It consumes small CSV/GeoTIFF outputs from GEE. |
| Heavy raster computation | **not R** | Even with `rgee`, pulling full-resolution Canada-wide rasters into R would exhaust local RAM. |

`rgee` is **optionally** used in the R script for a targeted pixel-level
spatial sample extraction only (Section 7 of `soc_comparison_analysis.R`).
All raster operations remain in GEE JavaScript.

### Outputs

| Output | Format | Location |
|--------|--------|----------|
| Harmonized stock and difference rasters | GEE asset (GeoTIFF) | `users/YOUR_USERNAME/SOC_comparison/` |
| Per-ecozone zonal statistics | GEE FeatureCollection + CSV | GEE asset + Google Drive `GEE_Exports/` |
| Summary table | CSV | `outputs/summary_table.csv` |
| Bland-Altman plots | PNG | `outputs/bland_altman_*.png` |
| Ecozone bias charts | PNG | `outputs/ecozone_bias_*.png` |
| Uncertainty heatmap | PNG | `outputs/uncertainty_heatmap.png` |

---

## 2. Prerequisites

### 2.1 GEE Access

A Google Earth Engine account is required. GEE is free for research and
non-commercial use.

Sign up at: <https://earthengine.google.com/signup/>

Once approved (can take a few hours), you can access the Code Editor at:
<https://code.earthengine.google.com/>

### 2.2 GEE Command-Line Tool (for uploading local rasters)

The `earthengine` CLI is needed to upload local GeoTIFFs as GEE assets.
SoilGrids and any community-catalog products do not need uploading — they are
already accessible in GEE. Upload is only required for locally held rasters
(e.g., the Sothe dataset, Geng 2025, Hengl 2023).

**Step 1 — Install the Earth Engine Python API:**

```bash
pip install earthengine-api
```

**Step 2 — Authenticate:**

```bash
earthengine authenticate
```

This opens a browser window. Follow the prompts and paste the authorization
token back into the terminal.

**Step 3 — Verify authentication:**

```bash
earthengine ls users/YOUR_USERNAME
```

Replace `YOUR_USERNAME` with your GEE username (not your email address — just
the part before `@` in your Google account, or the username shown in the GEE
Code Editor URL).

### 2.3 R Environment

**Required packages** — install before running the R script:

```r
install.packages(c("tidyverse", "terra", "sf", "tmap", "patchwork"))
```

Tested with R ≥ 4.2. The script uses the base R pipe (`|>`) introduced in
R 4.1 — do not use an older version.

**Optional packages** (for pixel-level sample extraction in Section 7):

```r
install.packages("rgee")
rgee::ee_install()     # installs the Python Earth Engine API for rgee
rgee::ee_Initialize()  # opens browser to authenticate — do this once
```

`rgee` requires a working Python environment with the `earthengine-api`
package installed. If you completed Step 2.2 above, the authentication is
already set up.

---

## 3. Uploading Local Rasters to GEE

GEE cannot read files from your local machine — rasters must be uploaded as
GEE assets before the JavaScript script can access them.

### What does NOT need to be uploaded

The following are already available through the GEE community catalog and are
loaded directly by the script — no upload required:

| Product | GEE path | Notes |
|---------|----------|-------|
| **Sothe et al. 2022 — Soil Carbon stock** | `projects/sat-io/open-datasets/carbon_stocks_ca/sc` | ImageCollection; script calls `.first()` |
| **SoilGrids SOC concentration** | `projects/soilgrids-isric/soc_mean` | OCS is computed from this + BDOD |
| **SoilGrids Bulk density** | `projects/soilgrids-isric/bdod_mean` | Used in OCS depth integration |

> **SoilGrids computation note:** This pipeline does **not** use a pre-integrated
> OCS asset. OCS (kg/m²) is computed by depth-integrating SOC concentration
> with bulk density across five standard depth intervals (0–5, 5–15, 15–30,
> 30–60, 60–100 cm), exactly following the approach validated in Charlie's
> Place KBA Forest Carbon Assessment v4.2. Band names are confirmed:
> `soc_0-5cm_mean` … `soc_60-100cm_mean` and `bdod_0-5cm_mean` … `bdod_60-100cm_mean`.

### What DOES need to be uploaded

Only two rasters require a local upload:

1. **Sothe et al. 2022 — Uncertainty raster** (from Zenodo doi:[10.4121/16686154.v3](https://doi.org/10.4121/16686154.v3))
2. **Geng 2025 / Hengl 2023** — if you activate those stubs (see stub comments in Section 2)

### 3.1 Create the destination folder (do this once)

```bash
earthengine create folder users/YOUR_USERNAME/SOC_comparison
```

### 3.2 Upload each raster

Use the following command template:

```bash
earthengine upload image \
  --asset_id=users/YOUR_USERNAME/SOC_comparison/ASSET_NAME \
  --crs=EPSG:3978 \
  /path/to/local/file.tif
```

**Sothe uncertainty raster** (required — download from Zenodo doi:[10.4121/16686154.v3](https://doi.org/10.4121/16686154.v3)):

```bash
earthengine upload image \
  --asset_id=users/YOUR_USERNAME/SOC_comparison/sothe_unc_kgm2_native \
  --crs=EPSG:3978 \
  /path/to/sothe_soc_uncertainty_0_1m.tif
```

> **Note:** The Sothe soil carbon **stock** raster does not need uploading — it
> is available via the sat-io GEE community catalog and is loaded automatically.
> Only the **uncertainty** raster requires a local upload.

**Geng et al. 2025 — Agriculture Canada 100 m (when activating this stub):**

```bash
earthengine upload image \
  --asset_id=users/YOUR_USERNAME/SOC_comparison/geng_2025_100m \
  --crs=EPSG:3978 \
  /path/to/geng_2025.tif
```

**Hengl et al. 2023 — Alberta 30 m (when activating this stub):**

```bash
earthengine upload image \
  --asset_id=users/YOUR_USERNAME/SOC_comparison/hengl_2023_30m \
  --crs=EPSG:3978 \
  /path/to/hengl_2023.tif
```

> **Note on `--crs`:** If your source file is already in EPSG:3978, this flag
> is informational. If it is in another projection (e.g., EPSG:4326), GEE
> stores it as-is and `--crs` tells GEE how to interpret it. The GEE script
> handles reprojection at analysis time via the `harmonize()` function.

### 3.3 Monitor upload progress

```bash
earthengine task list
```

The status sequence is: `READY → RUNNING → COMPLETED`

Large files (e.g., Geng 2025 at 100 m, Canada-wide) can take 20–60 minutes.
**Do not proceed to the GEE script until the upload status shows `COMPLETED`.**

### 3.4 Verify the uploaded uncertainty asset

Once upload completes, paste this into a new GEE Code Editor script and run:

```javascript
// Verify the Sothe uncertainty asset after upload
var unc = ee.Image('users/YOUR_USERNAME/SOC_comparison/sothe_unc_kgm2_native');
print('Uncertainty band names:', unc.bandNames());
print('Projection:',             unc.projection());
print('Scale (m):',              unc.projection().nominalScale());
```

Check that:
- The band name matches what you will put in `SOTHE_UNC_BAND`
- The projection is correct (EPSG:3978 or the expected native CRS)

> **Sothe stock verification** (community catalog — no upload needed):
> Paste the one-liner below into a new script to confirm the stock band name
> before filling in `SOTHE_STOCK_BAND`:
> ```javascript
> print(ee.ImageCollection('projects/sat-io/open-datasets/carbon_stocks_ca/sc')
>         .first().bandNames());
> ```

### 3.5 Activate a layer stub in the GEE script

After a successful upload:

1. Open `soc_comparison_gee.js` in a text editor or the Code Editor.
2. In the LAYERS registry (Section 2), uncomment the relevant stub.
3. Fill in `assetPath` with `users/YOUR_USERNAME/SOC_comparison/YOUR_ASSET_NAME`.
4. Fill in `bandName` with the band name confirmed in Step 3.4.
5. Confirm the `nativeUnit` and `convFactor` from the data documentation
   (see the unit conversion table in [Section 6](#6-adding-a-new-layer)).
6. Do not activate until all fields are confirmed.

---

## 4. Running the GEE Script

### 4.1 Confirm SoilGrids and Sothe band names (do this once before first run)

**SoilGrids SOC and BDOD bands** — confirmed from Charlie's Place KBA v4.2, but
paste the lines below into a new GEE script to verify nothing has changed since
the community catalog was last updated:

```javascript
// These band names were confirmed in Charlie's Place KBA v4.2 (Step 2 diagnostics)
print('SOC bands:',  ee.Image('projects/soilgrids-isric/soc_mean').bandNames());
print('BDOD bands:', ee.Image('projects/soilgrids-isric/bdod_mean').bandNames());
```

Expected output:
- SOC: `soc_0-5cm_mean`, `soc_5-15cm_mean`, `soc_15-30cm_mean`, `soc_30-60cm_mean`, `soc_60-100cm_mean`
- BDOD: `bdod_0-5cm_mean`, `bdod_5-15cm_mean`, `bdod_15-30cm_mean`, `bdod_30-60cm_mean`, `bdod_60-100cm_mean`

If the band names have changed, update `socBands` and `bdodBands` in the `soilgrids`
entry of the LAYERS registry (Section 2 of the GEE script).

**SoilGrids uncertainty (Q05/Q95) bands** — the quantile asset paths still need
verification. Paste this to check:

```javascript
// Check which uncertainty assets exist and their band names
// (expected: soc_p5 and soc_p95, or similar naming)
print('Q05 bands:', ee.Image('projects/soilgrids-isric/soc_p5').bandNames());
print('Q95 bands:', ee.Image('projects/soilgrids-isric/soc_p95').bandNames());
```

Once confirmed, update `uncAssetPath`, `uncBandName`, `uncQ95AssetPath`, and
`uncQ95BandName` in the `soilgrids` entry and remove the `VERIFY_` prefix from
those fields to activate uncertainty computation.

**Sothe soil carbon stock band name** — the community catalog asset exists but
the native band name needs to be confirmed before running:

```javascript
print('Sothe SC bands:',
  ee.ImageCollection('projects/sat-io/open-datasets/carbon_stocks_ca/sc')
    .first().bandNames());
```

Update `SOTHE_STOCK_BAND` in Section 0 with the confirmed name.

### 4.2 Fill in the CONFIG block

Open `soc_comparison_gee.js` and update the values at the top of the script
(Section 0). The table below shows what still requires user input:

| Variable | Status | What to fill in |
|----------|--------|----------------|
| `SOTHE_STOCK_ASSET` | **Pre-filled** | `projects/sat-io/open-datasets/carbon_stocks_ca/sc` (community catalog — no change needed) |
| `SOTHE_STOCK_BAND` | **Needs verification** | Run the `bandNames()` one-liner from Step 4.1 and fill in the confirmed band name |
| `SOTHE_UNC_ASSET` | **Required** | Your uploaded uncertainty asset path, e.g. `users/YOUR_USERNAME/SOC_comparison/sothe_unc_kgm2_native` |
| `SOTHE_UNC_BAND` | **Required** | Band name confirmed in Step 3.4 |
| `GEE_USERNAME` | **Required** | Your GEE username (not your email — just the username shown in the Code Editor URL) |
| `ECOZONES_ASSET` | **Required** | GEE asset path for a Canada ecozones polygon FeatureCollection. If you do not have one, see the fallback comment in Section 7 of the GEE script. |

The script throws an error immediately if any `PLACEHOLDER` value is still
present, and prints a warning (non-fatal) if any `VERIFY_` value is still set.
Both will appear in the console before any computation begins.

> **SoilGrids requires no config changes.** The `soilgrids` layer uses
> `computeOCS: true` and reads directly from the community catalog
> `soc_mean` and `bdod_mean` assets with confirmed band names. No asset
> path or convFactor needs to be changed in the CONFIG block.

### 4.3 Open the script in the GEE Code Editor

Go to <https://code.earthengine.google.com/> and either:
- Paste the contents of `soc_comparison_gee.js` directly into a new script, or
- Save it to your GEE scripts repository and open it from there.

### 4.4 Run in stages — do not submit all exports at once

**Stage 1 — Dry run (no exports):**

1. Comment out **all** `exportAsset()`, `exportDrive()`, and
   `Export.table.*()` calls.
2. Click **Run**.
3. Check the console output for the run summary and any errors.
4. Visually inspect the layers added to the map panel.
5. Fix any errors before proceeding.

**Stage 2 — Group A: Reference verification:**

1. Uncomment only the **Group A** export calls (the two lines that export
   `sothe_stock_kgm2` and `sothe_unc_kgm2`).
2. Click **Run**, then open the **Tasks tab** (top right) and click
   **Submit** next to each task.
3. Wait for `COMPLETED` status.
4. Open the **Assets panel**, find `sothe_stock_kgm2`, and click to inspect
   it visually.
5. **Expected values by region (Sothe 0–1 m):**

   | Region | Expected range (kg/m²) |
   |--------|------------------------|
   | Hudson Bay Lowlands (boreal peatland) | 40–80 |
   | Boreal forest (mixed mineral soil) | 5–20 |
   | Prairie / Alberta agricultural | 3–10 |
   | Arctic tundra (permafrost) | 10–40 |

   If values are implausibly low (<1 across boreal areas) or high (>200),
   stop and re-check `SOTHE_STOCK_BAND` in the CONFIG block. The community
   catalog band name must match exactly — a mismatched band name typically
   returns near-zero or all-null pixels.

**Stage 3 — Groups B, C, D:**

1. Uncomment all remaining export calls.
2. Click **Run**, then submit all tasks in the Tasks tab.
3. GEE queues tasks automatically — they run concurrently. No need to wait
   between groups.

### 4.5 Monitor export progress

In the GEE Code Editor, the **Tasks tab** shows live status for all submitted
jobs. Alternatively:

```bash
earthengine task list
```

Canada-wide 250 m exports typically complete in 10–45 minutes per layer,
depending on GEE server load.

---

## 5. Running the R Script

### 5.1 Get the zonal CSV from Google Drive

After the GEE export tasks complete, the file
`GEE_Exports/SOC_zonal_ecozones.csv` will appear in your **Google Drive**.

Download it to your local machine using Google Drive's web interface or the
`googledrive` R package.

### 5.2 Configure `soc_comparison_analysis.R`

Open `soc_comparison_analysis.R` and fill in the paths in Section 0:

```r
CSV_DIR      <- "/path/to/folder/containing/SOC_zonal_ecozones.csv/"
RASTER_DIR   <- "/path/to/GeoTIFFs/"       # optional; leave as-is if not downloading GeoTIFFs
OUTPUT_DIR   <- "/path/to/output/figures/"
GEE_USERNAME <- "your_gee_username"         # needed only for Section 7 (rgee)
```

The `OUTPUT_DIR` will be created automatically if it does not exist.

### 5.3 Run the script

From **RStudio**: open the file and click **Source**, or run sections
interactively.

From the **terminal**:

```bash
Rscript soc_comparison_analysis.R
```

The core workflow (Sections 2–6) runs entirely from the CSV. GeoTIFF loading
and the `rgee` pixel extraction (Section 7) are optional and skip with an
informative message if the files or packages are not present.

### 5.4 Expected output files

| File | Description |
|------|-------------|
| `summary_table.csv` | Mean absolute diff, relative diff, RMSE, and normalized diff per layer × ecozone |
| `bland_altman_soilgrids.png` | Bland-Altman plot: Sothe vs. SoilGrids, ecozone-level means |
| `ecozone_bias_absolute.png` | Faceted bar chart: mean absolute difference (kg/m²) by ecozone |
| `ecozone_bias_relative.png` | Faceted bar chart: mean relative difference (%) by ecozone |
| `uncertainty_heatmap.png` | Heatmap: uncertainty-normalized difference (σ units) by ecozone × layer |

> **Adding `frac_gt1` to the heatmap:** The fraction of pixels where
> |diff\_norm\_combined| > 1 is not currently exported from GEE. To add it:
> in `soc_comparison_gee.js`, before the zonal reduction, compute
> `diff_norm_combined.abs().gt(1).rename(id + '_exceeds_combined_unc')`
> and include it in `stackedDiffs`. The R script will then detect it and
> populate the `frac_gt1` column automatically.

---

## 6. Adding a New Layer

Follow these steps when adding a product (e.g., activating the Geng 2025 or
Hengl 2023 stubs, or adding an entirely new layer):

1. **Upload the raster to GEE** following the instructions in Section 3.

2. **Read the data documentation** for the product. Confirm:
   - Native unit (see conversion table below)
   - Depth interval (confirm it is 0–1 m, or document any mismatch)
   - Whether the product is a **stock** (kg/m², t/ha, hg/m²) or a
     **concentration** (g/kg, %). Concentrations cannot be compared directly
     — they require multiplication by bulk density and integration over depth
     before a convFactor applies.
   - Whether uncertainty estimates are available and in what form.

3. **Calculate the `convFactor`** to convert the native unit to kg/m²:

   | Native unit | × factor | = kg/m² | Notes |
   |-------------|----------|---------|-------|
   | kg/m² | 1.0 | kg/m² | Sothe — no conversion |
   | hg/m² | 0.1 | kg/m² | SoilGrids OCS (1 hg = 0.1 kg) |
   | t/ha | 0.1 | kg/m² | Hengl 2023 (1 t/ha = 10,000 kg / 10,000 m²) |
   | Mg/ha | 0.1 | kg/m² | Same as t/ha (1 Mg = 1 t) |
   | MgC/ha | 0.1 | kg/m² | Same as t/ha |
   | g/kg (concentration) | — | requires ρ_b × depth first | Cannot use convFactor directly |

4. **Add a descriptor object to the LAYERS registry** in `soc_comparison_gee.js`
   (Section 2). Fill in **all fields**. If uncommenting a stub, also fill in
   `assetPath` and `bandName`. Add an inline `convNote` comment showing the
   dimensional check.

5. **Add the layer ID to `LAYER_IDS`** in `soc_comparison_analysis.R`
   (Section 0), e.g.:
   ```r
   LAYER_IDS <- c("soilgrids", "geng_2025")
   ```

6. **Re-run Groups B–D of the GEE script only.** Group A (reference
   verification) does not change. The new layer will automatically be picked up
   by the `compLayers` loop — no other changes to the GEE script are needed.

7. **Re-download the updated zonal CSV** from Google Drive (the export
   `SOC_zonal_ecozones_csv` will be re-run with the new bands included).

8. **Re-run `soc_comparison_analysis.R`** to generate updated figures.

---

## 7. Known Limitations and Caveats

### SoilGrids uncertainty approximation

The SoilGrids uncertainty estimate used in this pipeline is derived from the
Q05 and Q95 quantile bands as an approximate 1-sigma:

```
sigma ≈ (Q95 − Q05) / (2 × 1.645)
```

This assumes the quantile distribution is approximately normal. SoilGrids
quantile regression forest (QRF) distributions are often **right-skewed in
high-SOC areas** (boreal peatlands, wetlands), meaning the true uncertainty
is higher than this approximation suggests. Treat `diff_norm_combined` values
in peatland-dominated ecozones (Hudson Bay Lowlands, Boreal Shield) with
caution — the normalized values are likely **underestimates** of significance.

### Depth interval inconsistency

All layers are nominally compared at 0–1 m, but the methodological definition
of "1 m depth" differs between products. Sothe applies a rooting depth mask
that limits the integration to biologically active soil. SoilGrids follows
GlobalSoilMap standard depth intervals (0–5, 5–15, 15–30, 30–60, 60–100 cm)
which may not align with Sothe's biologically defined profile. Systematic bias
arising from this source **cannot be fully separated** from true spatial
disagreement in the outputs.

### Sothe is not ground truth

Sothe et al. (2022) is used as the spatial reference layer because it is the
WWF Canada operational SOC product — not because it is independently validated
as the most accurate product. Known issues include:

- **Overestimation in Alberta agricultural soils** of approximately 1.5–2×
  compared to field-based estimates (Hengl et al. 2023, FACETS). When
  interpreting negative bias in comparison layers over agricultural ecozones,
  this is a plausible explanation.
- The Sothe model was trained predominantly on forest and peatland plots.
  Performance in tilled agricultural soils and alpine tundra is less
  well-characterized.

### SoilGrids global model performance in Canada

SoilGrids is trained on a global ISRIC database with sparse coverage in
northern Canada, permafrost zones, and subarctic organic soils. Expect
lower predictive accuracy (and potentially wider uncertainty intervals) in
boreal and subarctic ecozones. The global training approach may not capture
the high spatial variability of SOC in permafrost terrain.

### Vector layers not included

The following products are not included in the current version of the
pipeline because they require rasterization before comparison:

- **Olefeldt et al. (2016)** — thermokarst polygon dataset (wetland-specific
  carbon stocks)
- **Hugelius et al. (2013)** — Northern Circumpolar Soil Carbon Database
  (NCSCDv2, permafrost-zone organic layer stocks)

These can be integrated by rasterizing the polygon datasets in GEE
(`FeatureCollection.reduceToImage()`) and adding them to the LAYERS registry
as raster assets.

### Memory and computation at Canada-wide 250 m

All `reduceRegions()` calls use `tileScale: 4` to prevent memory errors.
If GEE returns `User memory limit exceeded` errors, increase `tileScale` to
8 or 16. This increases processing time but does not affect output values.

---

## 8. File Structure

### Repository

```
soc-comparison/
├── soc_comparison_gee.js        GEE JavaScript pipeline (all raster ops)
├── soc_comparison_analysis.R    R statistical analysis and figures
├── README.md                    this file
└── outputs/                     generated locally by soc_comparison_analysis.R
    ├── summary_table.csv
    ├── bland_altman_soilgrids.png
    ├── ecozone_bias_absolute.png
    ├── ecozone_bias_relative.png
    └── uncertainty_heatmap.png
```

### GEE asset structure

After running all export groups, your GEE account will contain:

```
users/YOUR_USERNAME/SOC_comparison/
├── sothe_stock_kgm2              reference stock raster (250 m, EPSG:3978)
├── sothe_unc_kgm2                reference uncertainty raster
├── soilgrids_stock_kgm2          SoilGrids harmonized stock
├── soilgrids_diff_abs_kgm2       absolute difference (SoilGrids − Sothe)
├── soilgrids_diff_rel_pct        relative difference (%)
├── soilgrids_diff_norm_sothe     difference / Sothe uncertainty
├── soilgrids_diff_norm_combined  difference / combined uncertainty
├── soilgrids_unc_kgm2            SoilGrids derived uncertainty (1-sigma)
├── n_valid                       per-pixel layer count (1 to N)
├── zero_vs_null                  per-layer mask status (0/1/2)
├── mask_agree                    pixels valid in ALL layers simultaneously
├── cross_mean_kgm2               mean across comparison layers
├── cross_sd_kgm2                 SD across comparison layers (ensemble spread)
├── spread_vs_sothe_unc           cross-SD / Sothe uncertainty ratio
└── SOC_zonal_ecozones            ecozone summary (FeatureCollection)
```

### Google Drive exports (in `GEE_Exports/`)

```
GEE_Exports/
├── SOC_zonal_ecozones.csv        ← primary input for soc_comparison_analysis.R
├── soilgrids_diff_abs_kgm2.tif   optional: for local spatial viz in R
└── soilgrids_diff_rel_pct.tif    optional: for local spatial viz in R
```

---

## Citation

If you use this pipeline, please cite the underlying datasets:

- **Sothe et al. (2022):** Sothe, C., et al. (2022). Large soil carbon storage
  in terrestrial ecosystems of Canada. *Global Biogeochemical Cycles*, 36,
  e2021GB007213. doi:[10.1029/2021GB007213](https://doi.org/10.1029/2021GB007213)

- **Poggio et al. (2021):** Poggio, L., et al. (2021). SoilGrids 2.0: producing
  soil information for the globe with quantified spatial uncertainty. *SOIL*, 7,
  217–240. doi:[10.5194/soil-7-217-2021](https://doi.org/10.5194/soil-7-217-2021)

- **Geng et al. (2025)** *(if activated):* Geng, X., et al. (2025). A 100-m
  resolution soil organic carbon map for Canada. *Scientific Data*, 12, 1178.
  doi:[10.1038/s41597-025-05460-4](https://doi.org/10.1038/s41597-025-05460-4)

- **Hengl et al. (2023)** *(if activated):* Hengl, T., et al. (2023).
  Soil organic carbon stocks in Alberta, Canada. *FACETS*, 8, 1–17.
  doi:[10.1139/facets-2023-0040](https://doi.org/10.1139/facets-2023-0040)

# ══════════════════════════════════════════════════════════════════════════════
# FOREST CARBON MAP COMPARISON — R Statistical Analysis
# Consumes outputs exported by forest_carbon_comparison_gee.js
#
# Required input: zonal CSV exported from GEE Section 7
# Optional inputs: GeoTIFFs exported to Google Drive, rgee package
#
# Core workflow (Sections 2-7) runs from the CSV alone.
# GeoTIFF and rgee sections are optional and skip gracefully if unavailable.
#
# Products compared:
#   Reference: sothe_fc  (Sothe et al. 2021 Forest Carbon, kg C/m²)
#   Comparison: SCANFI v1.2, SBFI, GEDI L4A
#   All comparison products converted to kg C/m² via IPCC 2006 factors
#   (AGB × (1 + RS) × CF × 0.1; RS=0.285, CF=0.47 → factor=0.06040)
#
# Coverage note: GEDI L4A footprints are sparse north of ~53°N.
# Ecozone-level means for northern ecozones (Taiga Plains, Taiga Shield,
# Hudson Plains, Arctic) should be interpreted with caution.
# ══════════════════════════════════════════════════════════════════════════════


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 0 — CONFIG
# All user-editable paths and settings are defined here. Nothing is
# hardcoded elsewhere in the script.
# ─────────────────────────────────────────────────────────────────────────────

CSV_DIR    <- "path/to/GEE_Exports/"        # folder containing the zonal CSV
RASTER_DIR <- "path/to/local_rasters/"      # folder with GeoTIFFs from Drive
OUTPUT_DIR <- "path/to/figures/"            # destination for plots and tables

# Layer IDs — must exactly match the id fields in the GEE LAYERS registry.
# Extend this vector as additional layers are activated in the GEE script.
LAYER_IDS  <- c("scanfi", "sbfi", "gedi_l4a")

REF_ID     <- "sothe_fc"

# GEE username — needed only for the optional rgee section (Section 8).
GEE_USERNAME <- "PLACEHOLDER_GEE_USERNAME"

# Unit label for axis annotations
UNIT_LABEL <- "kg C/m²"   # renders as "kg C/m²"

# Ecozones where GEDI L4A coverage is known to be sparse (north of ~53°N).
# These are annotated with a coverage warning on GEDI-inclusive plots.
GEDI_SPARSE_ECOZONES <- c(
  "Taiga Plains", "Taiga Shield", "Hudson Plains",
  "Southern Arctic", "Northern Arctic", "Arctic Cordillera"
)


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1 — LIBRARY LOADING WITH INFORMATIVE ERRORS
# ─────────────────────────────────────────────────────────────────────────────

required_pkgs <- c("tidyverse", "terra", "sf", "tmap", "patchwork")

for (pkg in required_pkgs) {
  tryCatch(
    library(pkg, character.only = TRUE, quietly = TRUE),
    error = function(e) {
      stop(
        "Package '", pkg, "' is not installed.\n",
        "Install with: install.packages('", pkg, "')\n",
        "Then restart R and re-run this script.",
        call. = FALSE
      )
    }
  )
}

# knitr is optional — used only for formatted console table output.
has_knitr <- requireNamespace("knitr", quietly = TRUE)

# Create output directory if it does not already exist.
if (!dir.exists(OUTPUT_DIR)) {
  dir.create(OUTPUT_DIR, recursive = TRUE)
  message("Created output directory: ", OUTPUT_DIR)
}


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — LOAD ZONAL CSV
# ─────────────────────────────────────────────────────────────────────────────

csv_file <- file.path(CSV_DIR, "ForestC_zonal_ecozones.csv")

if (!file.exists(csv_file)) {
  stop(
    "Zonal CSV not found at: ", csv_file, "\n",
    "Download GEE_Exports/ForestC_zonal_ecozones.csv from Google Drive\n",
    "and set CSV_DIR in Section 0 to the folder containing it.",
    call. = FALSE
  )
}

zonal_raw <- read.csv(csv_file, stringsAsFactors = FALSE)

# GEE appends reducer suffixes to band names in exported CSVs
# (e.g., "_mean", "_median", "_stdDev", "_p10", "_p90").
# Standardise these and drop geometry / system columns added by GEE.
zonal_raw <- zonal_raw[, !grepl("^\\.geo$|^system:", names(zonal_raw))]
names(zonal_raw) <- gsub("_stdDev$", "_sd",  names(zonal_raw))
names(zonal_raw) <- gsub("_p10$",    "_p10", names(zonal_raw))
names(zonal_raw) <- gsub("_p90$",    "_p90", names(zonal_raw))

# The first non-system column from a reduceRegions output is typically
# the zone identifier (ecozone name or code).
ecozone_col <- names(zonal_raw)[1]

# Pivot to long format: one row per ecozone × metric combination.
zonal_long <- zonal_raw |>
  tidyr::pivot_longer(
    cols      = -dplyr::all_of(ecozone_col),
    names_to  = "metric",
    values_to = "value"
  ) |>
  dplyr::mutate(
    layer = stringr::str_extract(
      metric,
      paste(c(REF_ID, LAYER_IDS), collapse = "|")
    ),
    stat = stringr::str_extract(metric, "mean|median|sd|p10|p90"),
    metric_type = dplyr::case_when(
      grepl("diff_abs",            metric) ~ "diff_abs_kgm2",
      grepl("diff_rel",            metric) ~ "diff_rel_pct",
      grepl("diff_norm_combined",  metric) ~ "diff_norm_combined",
      grepl("diff_norm_sothe",     metric) ~ "diff_norm_sothe",
      grepl("_unc_",               metric) ~ "unc_kgm2",
      grepl("cross_mean",          metric) ~ "cross_mean_kgm2",
      grepl("cross_sd",            metric) ~ "cross_sd_kgm2",
      grepl("spread_vs",           metric) ~ "spread_vs_unc",
      grepl("scanfi_minus_sbfi",   metric) ~ "scanfi_sbfi_diff_kgm2",
      grepl("_kgm2",               metric) ~ "stock_kgm2",
      TRUE                                  ~ "other"
    )
  )

# Flag which ecozones have sparse GEDI coverage for downstream annotation.
zonal_raw$gedi_sparse <- zonal_raw[[ecozone_col]] %in% GEDI_SPARSE_ECOZONES

# Print a load summary to console.
n_ecozones <- dplyr::n_distinct(zonal_long[[ecozone_col]])
n_layers   <- dplyr::n_distinct(zonal_long$layer, na.rm = TRUE)
n_metrics  <- dplyr::n_distinct(zonal_long$metric_type, na.rm = TRUE)
na_count   <- sum(is.na(zonal_long$value))
n_gedi_sparse <- sum(zonal_raw$gedi_sparse)

message("\n── Zonal CSV loaded ──────────────────────────────────────")
message("  File:                  ", csv_file)
message("  Ecozones:              ", n_ecozones)
message("  GEDI-sparse ecozones:  ", n_gedi_sparse,
        " (interpret GEDI-inclusive stats with caution)")
message("  Layers:                ", n_layers)
message("  Metric types:          ", n_metrics)
message("  NA values:             ", na_count)
message("─────────────────────────────────────────────────────────\n")


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 3 — SUMMARY STATISTICS TABLE
# ─────────────────────────────────────────────────────────────────────────────

# Build a publication-ready summary per layer × ecozone.
summary_list <- lapply(LAYER_IDS, function(lid) {

  abs_mean_col  <- paste0(lid, "_diff_abs_kgm2_mean")
  abs_sd_col    <- paste0(lid, "_diff_abs_kgm2_sd")
  rel_mean_col  <- paste0(lid, "_diff_rel_pct_mean")
  norm_col      <- paste0(lid, "_diff_norm_combined_mean")
  available     <- names(zonal_raw)

  df <- data.frame(
    ecozone     = zonal_raw[[ecozone_col]],
    layer       = lid,
    gedi_sparse = if (lid == "gedi_l4a") zonal_raw$gedi_sparse else FALSE,
    stringsAsFactors = FALSE
  )

  df$mean_abs_diff_kgm2 <- if (abs_mean_col %in% available) {
    zonal_raw[[abs_mean_col]]
  } else {
    message("  [", lid, "] column not found: ", abs_mean_col)
    NA_real_
  }

  df$mean_rel_diff_pct <- if (rel_mean_col %in% available) {
    zonal_raw[[rel_mean_col]]
  } else {
    message("  [", lid, "] column not found: ", rel_mean_col)
    NA_real_
  }

  # RMSE approximation from zonal mean and SD: sqrt(mean² + sd²)
  # This is exact when the zonal mean is the true bias and SD is the
  # within-zone residual spread.
  if (abs_mean_col %in% available && abs_sd_col %in% available) {
    df$rmse_kgm2 <- sqrt(
      zonal_raw[[abs_mean_col]]^2 + zonal_raw[[abs_sd_col]]^2
    )
  } else {
    df$rmse_kgm2 <- NA_real_
  }

  df$mean_norm_combined <- if (norm_col %in% available) {
    zonal_raw[[norm_col]]
  } else {
    NA_real_
  }

  # Fraction of pixels with |diff_norm_combined| > 1.
  # Requires a pixel-count export from GEE not produced by the current
  # pipeline. Set to NA here; see README Section 6 for instructions.
  df$frac_norm_gt1 <- NA_real_

  df
})

summary_tbl <- do.call(rbind, summary_list)
rownames(summary_tbl) <- NULL

message("\n── Summary statistics table ──────────────────────────────")
if (has_knitr) {
  print(knitr::kable(
    summary_tbl[, !names(summary_tbl) %in% "gedi_sparse"],
    digits  = 2,
    caption = "Mean forest carbon differences vs. Sothe FC per layer and ecozone"
  ))
} else {
  print(summary_tbl[, !names(summary_tbl) %in% "gedi_sparse"])
}
message("─────────────────────────────────────────────────────────\n")

write.csv(
  summary_tbl[, !names(summary_tbl) %in% "gedi_sparse"],
  file      = file.path(OUTPUT_DIR, "forest_summary_table.csv"),
  row.names = FALSE
)
message("Saved: ", file.path(OUTPUT_DIR, "forest_summary_table.csv"))


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — BLAND-ALTMAN PLOT
# Classic Bland-Altman (mean vs. difference) using ecozone-level means as
# observations. One plot per comparison layer.
# GEDI L4A plots include a coverage warning for northern ecozones.
# ─────────────────────────────────────────────────────────────────────────────

for (lid in LAYER_IDS) {

  ref_col  <- paste0(REF_ID, "_kgm2_mean")
  comp_col <- paste0(lid,    "_kgm2_mean")
  diff_col <- paste0(lid,    "_diff_abs_kgm2_mean")

  if (!diff_col %in% names(zonal_raw)) {
    message("Bland-Altman [", lid, "]: column '", diff_col,
            "' not found — skipping.")
    next
  }

  ba_data <- data.frame(
    ecozone     = zonal_raw[[ecozone_col]],
    diff_abs    = zonal_raw[[diff_col]],
    gedi_sparse = zonal_raw$gedi_sparse,
    stringsAsFactors = FALSE
  )

  # x-axis: mean of both products if both stock columns are present;
  # fall back to comparison stock or sequential index.
  if (ref_col %in% names(zonal_raw) && comp_col %in% names(zonal_raw)) {
    ba_data$mean_val <- (zonal_raw[[ref_col]] + zonal_raw[[comp_col]]) / 2
  } else if (comp_col %in% names(zonal_raw)) {
    ba_data$mean_val <- zonal_raw[[comp_col]]
    message("Bland-Altman [", lid, "]: reference stock column absent — ",
            "using comparison stock on x-axis.")
  } else {
    ba_data$mean_val <- seq_len(nrow(ba_data))
    message("Bland-Altman [", lid, "]: stock columns absent — using index on x-axis.")
  }

  ba_data <- ba_data[stats::complete.cases(ba_data[, c("mean_val", "diff_abs")]), ]

  if (nrow(ba_data) < 3) {
    message("Bland-Altman [", lid, "]: fewer than 3 complete rows — skipping.")
    next
  }

  mean_bias <- mean(ba_data$diff_abs, na.rm = TRUE)
  sd_diff   <- stats::sd(ba_data$diff_abs, na.rm = TRUE)
  loa_upper <- mean_bias + 1.96 * sd_diff
  loa_lower <- mean_bias - 1.96 * sd_diff

  message(sprintf(
    "Bland-Altman [%s]:  mean bias = %.3f %s  |  LoA = [%.3f, %.3f]",
    lid, mean_bias, UNIT_LABEL, loa_lower, loa_upper
  ))

  # GEDI points: distinguish sparse-coverage ecozones with open symbols.
  if (lid == "gedi_l4a") {
    p_ba <- ggplot2::ggplot(
      ba_data,
      ggplot2::aes(
        x     = mean_val,
        y     = diff_abs,
        colour = ecozone,
        shape  = gedi_sparse
      )
    ) +
      ggplot2::scale_shape_manual(
        values = c("FALSE" = 16, "TRUE" = 1),
        labels = c("FALSE" = "Dense coverage", "TRUE" = "Sparse coverage (≤53°N)"),
        name   = "GEDI coverage"
      )
  } else {
    p_ba <- ggplot2::ggplot(
      ba_data,
      ggplot2::aes(x = mean_val, y = diff_abs, colour = ecozone)
    )
  }

  p_ba <- p_ba +
    ggplot2::geom_point(size = 2.5, alpha = 0.85) +
    ggplot2::geom_hline(
      yintercept = mean_bias, linetype = "dashed",
      colour = "black", linewidth = 0.8
    ) +
    ggplot2::geom_hline(
      yintercept = loa_upper, linetype = "dotted",
      colour = "firebrick", linewidth = 0.8
    ) +
    ggplot2::geom_hline(
      yintercept = loa_lower, linetype = "dotted",
      colour = "firebrick", linewidth = 0.8
    ) +
    ggplot2::annotate(
      "text", x = Inf, y = mean_bias,  hjust = 1.1, vjust = -0.4,
      label = sprintf("Bias = %.2f %s", mean_bias, UNIT_LABEL), size = 3.2
    ) +
    ggplot2::annotate(
      "text", x = Inf, y = loa_upper,  hjust = 1.1, vjust = -0.4,
      label = sprintf("+1.96 SD = %.2f", loa_upper), size = 3.2
    ) +
    ggplot2::annotate(
      "text", x = Inf, y = loa_lower,  hjust = 1.1, vjust = 1.4,
      label = sprintf("-1.96 SD = %.2f", loa_lower), size = 3.2
    ) +
    ggplot2::labs(
      title    = paste0("Bland-Altman: Sothe FC vs. ", lid),
      subtitle = paste0(
        "Points = ecozone-level means  |  dashed = mean bias  |  dotted = ±1.96 SD",
        if (lid == "gedi_l4a") "\nOpen circles = ecozones with sparse GEDI coverage (north of ~53°N)" else ""
      ),
      x        = paste0("Mean of Sothe FC & ", lid, " (", UNIT_LABEL, ")"),
      y        = paste0("Difference (", lid, " − Sothe FC, ", UNIT_LABEL, ")"),
      colour   = "Ecozone"
    ) +
    ggplot2::theme_bw(base_size = 11) +
    ggplot2::theme(legend.position = "right")

  out_path <- file.path(OUTPUT_DIR, paste0("bland_altman_", lid, ".png"))
  ggplot2::ggsave(out_path, p_ba, width = 9, height = 6, dpi = 150)
  message("Saved: ", out_path)
  print(p_ba)
}


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — ECOZONE BIAS PLOTS
# Faceted bar charts of mean absolute and relative difference by ecozone.
# Ecozones reordered by bias magnitude for easy identification of outliers.
# GEDI-sparse ecozones are annotated with an asterisk on bar labels.
# ─────────────────────────────────────────────────────────────────────────────

# Helper: add GEDI-sparse asterisk to ecozone labels on the y-axis.
make_ecozone_label <- function(ecozone_vec) {
  ifelse(ecozone_vec %in% GEDI_SPARSE_ECOZONES,
         paste0(ecozone_vec, " *"),
         ecozone_vec)
}

# ── Absolute difference ───────────────────────────────────────────────────
plot_data_abs <- summary_tbl[!is.na(summary_tbl$mean_abs_diff_kgm2), ]

if (nrow(plot_data_abs) > 0) {

  # Determine ecozone order by mean absolute bias magnitude across all layers.
  ecozone_order_abs <- plot_data_abs |>
    dplyr::group_by(ecozone) |>
    dplyr::summarise(
      mean_mag = mean(abs(mean_abs_diff_kgm2), na.rm = TRUE),
      .groups  = "drop"
    ) |>
    dplyr::arrange(dplyr::desc(mean_mag)) |>
    dplyr::pull(ecozone)

  plot_data_abs$ecozone       <- factor(plot_data_abs$ecozone, levels = ecozone_order_abs)
  plot_data_abs$ecozone_label <- make_ecozone_label(as.character(plot_data_abs$ecozone))
  plot_data_abs$ecozone_label <- factor(
    plot_data_abs$ecozone_label,
    levels = make_ecozone_label(ecozone_order_abs)
  )

  # Attach within-ecozone SD for error bars from the wide table.
  plot_data_abs$sd_abs <- NA_real_
  for (lid in LAYER_IDS) {
    sd_col <- paste0(lid, "_diff_abs_kgm2_sd")
    if (sd_col %in% names(zonal_raw)) {
      idx <- plot_data_abs$layer == lid
      plot_data_abs$sd_abs[idx] <- zonal_raw[[sd_col]][
        match(as.character(plot_data_abs$ecozone[idx]),
              as.character(zonal_raw[[ecozone_col]]))
      ]
    }
  }

  p_abs <- ggplot2::ggplot(
    plot_data_abs,
    ggplot2::aes(x = ecozone_label, y = mean_abs_diff_kgm2, fill = layer)
  ) +
    ggplot2::geom_col(
      position = ggplot2::position_dodge(0.8), width = 0.7
    ) +
    ggplot2::geom_errorbar(
      ggplot2::aes(
        ymin = mean_abs_diff_kgm2 - sd_abs,
        ymax = mean_abs_diff_kgm2 + sd_abs
      ),
      position = ggplot2::position_dodge(0.8),
      width    = 0.25,
      na.rm    = TRUE
    ) +
    ggplot2::facet_wrap(~layer, ncol = 1) +
    ggplot2::coord_flip() +
    ggplot2::labs(
      title    = "Mean Absolute Forest Carbon Difference by Ecozone",
      subtitle = paste0(
        "Error bars = ±1 SD (within-ecozone spread)\n",
        "* = ecozone with sparse GEDI L4A coverage (north of ~53°N)"
      ),
      x        = "Ecozone (ordered by mean bias magnitude)",
      y        = paste0("Mean absolute difference (", UNIT_LABEL, ")"),
      fill     = "Layer"
    ) +
    ggplot2::theme_bw(base_size = 11) +
    ggplot2::theme(legend.position = "none")

  out_abs <- file.path(OUTPUT_DIR, "ecozone_bias_absolute.png")
  ggplot2::ggsave(out_abs, p_abs, width = 10, height = 8, dpi = 150)
  message("Saved: ", out_abs)
  print(p_abs)
} else {
  message("Ecozone absolute bias plot: no data — skipping.")
}

# ── Relative difference ───────────────────────────────────────────────────
plot_data_rel <- summary_tbl[!is.na(summary_tbl$mean_rel_diff_pct), ]

if (nrow(plot_data_rel) > 0) {

  ecozone_order_rel <- plot_data_rel |>
    dplyr::group_by(ecozone) |>
    dplyr::summarise(
      mean_mag = mean(abs(mean_rel_diff_pct), na.rm = TRUE),
      .groups  = "drop"
    ) |>
    dplyr::arrange(dplyr::desc(mean_mag)) |>
    dplyr::pull(ecozone)

  plot_data_rel$ecozone       <- factor(plot_data_rel$ecozone, levels = ecozone_order_rel)
  plot_data_rel$ecozone_label <- make_ecozone_label(as.character(plot_data_rel$ecozone))
  plot_data_rel$ecozone_label <- factor(
    plot_data_rel$ecozone_label,
    levels = make_ecozone_label(ecozone_order_rel)
  )

  p_rel <- ggplot2::ggplot(
    plot_data_rel,
    ggplot2::aes(x = ecozone_label, y = mean_rel_diff_pct, fill = layer)
  ) +
    ggplot2::geom_col(
      position = ggplot2::position_dodge(0.8), width = 0.7
    ) +
    ggplot2::geom_hline(
      yintercept = 0, colour = "grey30", linewidth = 0.4
    ) +
    ggplot2::facet_wrap(~layer, ncol = 1) +
    ggplot2::coord_flip() +
    ggplot2::labs(
      title    = "Mean Relative Forest Carbon Difference by Ecozone",
      subtitle = paste0(
        "Positive = comparison layer reports more forest C than Sothe FC\n",
        "* = ecozone with sparse GEDI L4A coverage (north of ~53°N)"
      ),
      x        = "Ecozone (ordered by mean relative bias magnitude)",
      y        = "Mean relative difference (%)",
      fill     = "Layer"
    ) +
    ggplot2::theme_bw(base_size = 11) +
    ggplot2::theme(legend.position = "none")

  out_rel <- file.path(OUTPUT_DIR, "ecozone_bias_relative.png")
  ggplot2::ggsave(out_rel, p_rel, width = 10, height = 8, dpi = 150)
  message("Saved: ", out_rel)
  print(p_rel)
} else {
  message("Ecozone relative bias plot: no data — skipping.")
}


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6 — UNCERTAINTY-NORMALIZED HEATMAP
# Heatmap: ecozone (rows) × comparison layer (columns)
# Fill: mean diff_norm_combined value (σ units)
# Diverging scale: blue = underestimate, red = overestimate
# Cells with |mean| > 1 = systematic bias exceeding combined uncertainty.
#
# Note: GEDI L4A and SCANFI do not have pixel-level uncertainty estimates in
# the current GEE pipeline. Only cells where both Sothe FC and the comparison
# layer have uncertainty rasters will be populated (currently gedi_l4a only,
# via agbd_se). SCANFI and SBFI cells will appear grey (NA).
# ─────────────────────────────────────────────────────────────────────────────

norm_cols_needed <- paste0(LAYER_IDS, "_diff_norm_combined_mean")
norm_cols_found  <- norm_cols_needed[norm_cols_needed %in% names(zonal_raw)]

if (length(norm_cols_found) == 0) {
  message(
    "Uncertainty heatmap: no diff_norm_combined columns found in CSV ",
    "(expected columns: ", paste(norm_cols_needed, collapse = ", "), "). ",
    "This column requires both products to have uncertainty estimates. Skipping."
  )
} else {

  heatmap_data <- zonal_raw |>
    dplyr::select(dplyr::all_of(c(ecozone_col, "gedi_sparse", norm_cols_found))) |>
    tidyr::pivot_longer(
      cols      = dplyr::all_of(norm_cols_found),
      names_to  = "layer_col",
      values_to = "norm_mean"
    ) |>
    dplyr::mutate(
      layer      = stringr::str_remove(layer_col, "_diff_norm_combined_mean$"),
      norm_label = dplyr::case_when(
        is.na(norm_mean) & layer != "gedi_l4a" ~ "no unc",
        is.na(norm_mean) & gedi_sparse          ~ "sparse",
        is.na(norm_mean)                         ~ "NA",
        TRUE                                     ~ sprintf("%.1f", norm_mean)
      )
    )

  message(
    "Uncertainty heatmap: SCANFI and SBFI cells will be grey (no pixel-level ",
    "uncertainty in current pipeline). GEDI L4A uses agbd_se as proxy uncertainty."
  )

  max_abs_norm <- max(abs(heatmap_data$norm_mean), na.rm = TRUE)
  if (is.infinite(max_abs_norm) || max_abs_norm == 0) max_abs_norm <- 1

  p_heat <- ggplot2::ggplot(
    heatmap_data,
    ggplot2::aes(
      x    = layer,
      y    = .data[[ecozone_col]],
      fill = norm_mean
    )
  ) +
    ggplot2::geom_tile(colour = "white", linewidth = 0.5) +
    ggplot2::geom_text(
      ggplot2::aes(label = norm_label),
      size   = 3,
      colour = "black"
    ) +
    ggplot2::scale_fill_distiller(
      palette  = "RdBu",
      limits   = c(-max_abs_norm, max_abs_norm),
      name     = "Norm. diff\n(σ units)",
      na.value = "grey80"
    ) +
    ggplot2::labs(
      title    = "Uncertainty-Normalised Difference: Ecozone × Layer",
      subtitle = paste0(
        "Values in σ units (combined Sothe FC + layer uncertainty).\n",
        "Grey cells: no pixel-level uncertainty for this product.\n",
        "Cells with |value| > 1: systematic bias not explained by product uncertainty."
      ),
      x = "Comparison layer",
      y = "Ecozone"
    ) +
    ggplot2::theme_bw(base_size = 11) +
    ggplot2::theme(
      axis.text.x = ggplot2::element_text(angle = 30, hjust = 1),
      panel.grid  = ggplot2::element_blank()
    )

  out_heat <- file.path(OUTPUT_DIR, "uncertainty_heatmap.png")
  ggplot2::ggsave(out_heat, p_heat, width = 8, height = 9, dpi = 150)
  message("Saved: ", out_heat)
  print(p_heat)
}


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — SCANFI vs. SBFI DIRECT COMPARISON
# Both are biomass-derived products converted with the same IPCC factors.
# Their difference is not a comparison against Sothe FC but a cross-product
# consistency check. The GEE script exports scanfi_minus_sbfi_kgm2.
# ─────────────────────────────────────────────────────────────────────────────

diff_ss_col <- "scanfi_minus_sbfi_kgm2_mean"
sd_ss_col   <- "scanfi_minus_sbfi_kgm2_sd"

if (!diff_ss_col %in% names(zonal_raw)) {
  message(
    "SCANFI-SBFI comparison: column '", diff_ss_col, "' not found in CSV.\n",
    "Ensure GEE Section 6 (SCANFI-SBFI direct comparison) ran successfully."
  )
} else {

  ss_data <- data.frame(
    ecozone      = zonal_raw[[ecozone_col]],
    diff_mean    = zonal_raw[[diff_ss_col]],
    diff_sd      = if (sd_ss_col %in% names(zonal_raw)) {
      zonal_raw[[sd_ss_col]]
    } else {
      NA_real_
    },
    stringsAsFactors = FALSE
  )

  ss_data <- ss_data[!is.na(ss_data$diff_mean), ]

  if (nrow(ss_data) < 2) {
    message("SCANFI-SBFI comparison: fewer than 2 complete rows — skipping.")
  } else {

    # Order ecozones by absolute bias magnitude.
    ss_order <- ss_data |>
      dplyr::arrange(dplyr::desc(abs(diff_mean))) |>
      dplyr::pull(ecozone)
    ss_data$ecozone <- factor(ss_data$ecozone, levels = ss_order)

    global_mean <- mean(ss_data$diff_mean, na.rm = TRUE)
    global_sd   <- stats::sd(ss_data$diff_mean, na.rm = TRUE)

    message(sprintf(
      "SCANFI vs. SBFI:  global mean diff = %.3f %s  |  SD = %.3f",
      global_mean, UNIT_LABEL, global_sd
    ))

    p_ss <- ggplot2::ggplot(
      ss_data,
      ggplot2::aes(x = ecozone, y = diff_mean)
    ) +
      ggplot2::geom_col(
        fill = "#4E79A7", width = 0.7, alpha = 0.85
      ) +
      ggplot2::geom_errorbar(
        ggplot2::aes(
          ymin = diff_mean - diff_sd,
          ymax = diff_mean + diff_sd
        ),
        width = 0.3, na.rm = TRUE
      ) +
      ggplot2::geom_hline(
        yintercept = 0, colour = "grey30", linewidth = 0.5
      ) +
      ggplot2::geom_hline(
        yintercept = global_mean, linetype = "dashed",
        colour = "black", linewidth = 0.7
      ) +
      ggplot2::annotate(
        "text", x = Inf, y = global_mean, hjust = 1.1, vjust = -0.4,
        label = sprintf("Global mean = %.2f %s", global_mean, UNIT_LABEL),
        size = 3.2
      ) +
      ggplot2::coord_flip() +
      ggplot2::labs(
        title    = "SCANFI v1.2 vs. SBFI: Direct Forest Carbon Comparison",
        subtitle = paste0(
          "Both converted to kg C/m² via IPCC 2006 (AGB × (1+RS) × CF × 0.1; RS=0.285, CF=0.47)\n",
          "Positive = SCANFI reports more forest C than SBFI\n",
          "Error bars = ±1 SD (within-ecozone spread)  |  dashed = global mean"
        ),
        x = "Ecozone (ordered by absolute difference)",
        y = paste0("SCANFI − SBFI (", UNIT_LABEL, ")")
      ) +
      ggplot2::theme_bw(base_size = 11)

    out_ss <- file.path(OUTPUT_DIR, "scanfi_vs_sbfi_direct.png")
    ggplot2::ggsave(out_ss, p_ss, width = 9, height = 7, dpi = 150)
    message("Saved: ", out_ss)
    print(p_ss)
  }
}


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 8 — OPTIONAL: rgee SPATIAL SAMPLE EXTRACTION
#
# This section is OPTIONAL. It requires rgee to be installed and authenticated
# separately from the core R packages (see README Section 2.3).
#
# Use case: extract a stratified random sample of pixel-level difference values
# directly from GEE assets for scatter plots and pixel-level correlation.
#
# rgee is used here ONLY for this targeted data extraction — all heavy raster
# computation remains in the GEE JavaScript pipeline.
#
# If rgee is not available, this section skips gracefully with a message.
# ─────────────────────────────────────────────────────────────────────────────

if (requireNamespace("rgee", quietly = TRUE)) {

  message("\nrgee detected — attempting pixel-level sample extraction...")

  tryCatch({
    rgee::ee_Initialize()

    asset_root <- paste0("users/", GEE_USERNAME, "/ForestC_comparison/")

    # Load reference (Sothe FC) stock image.
    ref_img <- rgee::ee$Image(paste0(asset_root, "sothe_fc_kgm2"))

    for (lid in LAYER_IDS) {

      diff_asset <- paste0(asset_root, lid, "_diff_abs_kgm2")
      diff_img   <- tryCatch(
        rgee::ee$Image(diff_asset),
        error = function(e) {
          message("  rgee [", lid, "]: asset not found — ", conditionMessage(e))
          NULL
        }
      )
      if (is.null(diff_img)) next

      # Stratified random sample: 10,000 points drawn uniformly across Canada.
      # seed = 42 ensures reproducibility.
      sample_fc <- diff_img$sample(
        region    = diff_img$geometry(),
        scale     = 250,
        numPixels = 10000,
        seed      = 42
      )
      ref_fc <- ref_img$sample(
        region    = ref_img$geometry(),
        scale     = 250,
        numPixels = 10000,
        seed      = 42   # same seed → same spatial locations
      )

      pixel_df <- tryCatch(rgee::ee_as_sf(sample_fc), error = function(e) NULL)
      ref_df   <- tryCatch(rgee::ee_as_sf(ref_fc),    error = function(e) NULL)

      if (is.null(pixel_df) || is.null(ref_df)) {
        message("  rgee [", lid, "]: ee_as_sf failed — skipping scatter.")
        next
      }

      if (nrow(pixel_df) != nrow(ref_df)) {
        message("  rgee [", lid, "]: sample sizes differ — skipping scatter.")
        next
      }

      scatter_df <- data.frame(
        sothe_fc_kgm2 = as.numeric(ref_df[[1]]),
        diff_abs_kgm2 = as.numeric(pixel_df[[1]])
      )
      scatter_df[[paste0(lid, "_kgm2")]] <-
        scatter_df$sothe_fc_kgm2 + scatter_df$diff_abs_kgm2

      p_scatter <- ggplot2::ggplot(
        scatter_df,
        ggplot2::aes(x = sothe_fc_kgm2, y = .data[[paste0(lid, "_kgm2")]])
      ) +
        ggplot2::geom_bin2d(bins = 80) +
        ggplot2::geom_abline(
          slope = 1, intercept = 0,
          colour = "red", linetype = "dashed", linewidth = 0.8
        ) +
        ggplot2::scale_fill_viridis_c(
          trans = "log10", name = "N pixels"
        ) +
        ggplot2::labs(
          title    = paste0("Pixel-level scatter: Sothe FC vs. ", lid),
          subtitle = "n = 10,000 random sample  |  red dashed line = 1:1",
          x        = paste0("Sothe FC (", UNIT_LABEL, ")"),
          y        = paste0(lid, " (", UNIT_LABEL, ")")
        ) +
        ggplot2::theme_bw(base_size = 11)

      out_scatter <- file.path(OUTPUT_DIR, paste0("scatter_sothe_vs_", lid, ".png"))
      ggplot2::ggsave(out_scatter, p_scatter, width = 7, height = 6, dpi = 150)
      message("Saved: ", out_scatter)
      print(p_scatter)
    }

  }, error = function(e) {
    message("rgee extraction failed: ", conditionMessage(e))
    message("Check that GEE_USERNAME is correct and the GEE assets exist.")
  })

} else {
  message("\nrgee not available — skipping pixel-level sample extraction.")
  message("See README Section 2.3 for rgee installation and authentication.")
}


# ─────────────────────────────────────────────────────────────────────────────
# SESSION INFO — printed for reproducibility logging
# ─────────────────────────────────────────────────────────────────────────────

message("\n── Session information ───────────────────────────────────")
sessionInfo()

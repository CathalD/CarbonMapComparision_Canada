# ══════════════════════════════════════════════════════════════════════════════
# SOC MAP COMPARISON — R Statistical Analysis
# Consumes outputs exported by soc_comparison_gee.js
#
# Required input: zonal CSV exported from GEE Section 7
# Optional inputs: GeoTIFFs exported to Google Drive, rgee package
#
# Core workflow (Sections 2-6) runs from the CSV alone.
# GeoTIFF and rgee sections are optional and skip gracefully if unavailable.
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
LAYER_IDS  <- c("soilgrids")

REF_ID     <- "sothe_gbc"

# GEE username — needed only for the optional rgee section (Section 7).
GEE_USERNAME <- "PLACEHOLDER_GEE_USERNAME"

# Unit label for axis annotations (Unicode superscript 2)
UNIT_LABEL <- "kg/m²"   # renders as "kg/m²"


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

csv_file <- file.path(CSV_DIR, "SOC_zonal_ecozones.csv")

if (!file.exists(csv_file)) {
  stop(
    "Zonal CSV not found at: ", csv_file, "\n",
    "Download GEE_Exports/SOC_zonal_ecozones.csv from Google Drive\n",
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
      grepl("_kgm2",               metric) ~ "stock_kgm2",
      TRUE                                  ~ "other"
    )
  )

# Print a load summary to console.
n_ecozones <- dplyr::n_distinct(zonal_long[[ecozone_col]])
n_layers   <- dplyr::n_distinct(zonal_long$layer, na.rm = TRUE)
n_metrics  <- dplyr::n_distinct(zonal_long$metric_type, na.rm = TRUE)
na_count   <- sum(is.na(zonal_long$value))

message("\n── Zonal CSV loaded ──────────────────────────────────────")
message("  File:         ", csv_file)
message("  Ecozones:     ", n_ecozones)
message("  Layers:       ", n_layers)
message("  Metric types: ", n_metrics)
message("  NA values:    ", na_count)
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
    ecozone = zonal_raw[[ecozone_col]],
    layer   = lid,
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
    summary_tbl,
    digits  = 2,
    caption = "Mean SOC differences vs. Sothe per layer and ecozone"
  ))
} else {
  print(summary_tbl)
}
message("─────────────────────────────────────────────────────────\n")

write.csv(
  summary_tbl,
  file      = file.path(OUTPUT_DIR, "summary_table.csv"),
  row.names = FALSE
)
message("Saved: ", file.path(OUTPUT_DIR, "summary_table.csv"))


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — BLAND-ALTMAN PLOT
# Classic Bland-Altman (mean vs. difference) using ecozone-level means as
# observations. One plot per comparison layer.
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
    ecozone  = zonal_raw[[ecozone_col]],
    diff_abs = zonal_raw[[diff_col]],
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

  ba_data <- ba_data[stats::complete.cases(ba_data), ]

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

  p_ba <- ggplot2::ggplot(
    ba_data,
    ggplot2::aes(x = mean_val, y = diff_abs, colour = ecozone)
  ) +
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
      title    = paste0("Bland-Altman: Sothe vs. ", lid),
      subtitle = "Points = ecozone-level means  |  dashed = mean bias  |  dotted = ±1.96 SD",
      x        = paste0("Mean of Sothe & ", lid, " (", UNIT_LABEL, ")"),
      y        = paste0("Difference (", lid, " − Sothe, ", UNIT_LABEL, ")"),
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
# ─────────────────────────────────────────────────────────────────────────────

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

  plot_data_abs$ecozone <- factor(plot_data_abs$ecozone,
                                  levels = ecozone_order_abs)

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
    ggplot2::aes(x = ecozone, y = mean_abs_diff_kgm2, fill = layer)
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
      title    = "Mean Absolute SOC Difference by Ecozone",
      subtitle = "Error bars = ±1 SD (within-ecozone spread)",
      x        = "Ecozone (ordered by mean bias magnitude)",
      y        = paste0("Mean absolute difference (", UNIT_LABEL, ")"),
      fill     = "Layer"
    ) +
    ggplot2::theme_bw(base_size = 11) +
    ggplot2::theme(legend.position = "none")

  out_abs <- file.path(OUTPUT_DIR, "ecozone_bias_absolute.png")
  ggplot2::ggsave(out_abs, p_abs, width = 10, height = 7, dpi = 150)
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

  plot_data_rel$ecozone <- factor(plot_data_rel$ecozone,
                                  levels = ecozone_order_rel)

  p_rel <- ggplot2::ggplot(
    plot_data_rel,
    ggplot2::aes(x = ecozone, y = mean_rel_diff_pct, fill = layer)
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
      title    = "Mean Relative SOC Difference by Ecozone",
      subtitle = "Positive = comparison layer reports more SOC than Sothe",
      x        = "Ecozone (ordered by mean relative bias magnitude)",
      y        = "Mean relative difference (%)",
      fill     = "Layer"
    ) +
    ggplot2::theme_bw(base_size = 11) +
    ggplot2::theme(legend.position = "none")

  out_rel <- file.path(OUTPUT_DIR, "ecozone_bias_relative.png")
  ggplot2::ggsave(out_rel, p_rel, width = 10, height = 7, dpi = 150)
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
    dplyr::select(dplyr::all_of(c(ecozone_col, norm_cols_found))) |>
    tidyr::pivot_longer(
      cols      = dplyr::all_of(norm_cols_found),
      names_to  = "layer_col",
      values_to = "norm_mean"
    ) |>
    dplyr::mutate(
      layer      = stringr::str_remove(layer_col, "_diff_norm_combined_mean$"),
      norm_label = sprintf("%.1f", norm_mean)
    )

  # Note: frac_gt1 (fraction of pixels with |norm| > 1) requires a separate
  # pixel-count export from GEE (not produced by the current pipeline).
  # See README Section 5.4 for how to add this export.
  message(
    "Uncertainty heatmap: frac_gt1 column set to NA. A custom pixel-count ",
    "export from GEE is needed to populate it (see README Section 5.4)."
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
        "Values in σ units (combined Sothe + layer uncertainty).\n",
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
  ggplot2::ggsave(out_heat, p_heat, width = 8, height = 8, dpi = 150)
  message("Saved: ", out_heat)
  print(p_heat)
}


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — OPTIONAL: rgee SPATIAL SAMPLE EXTRACTION
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

    diff_asset <- paste0(
      "users/", GEE_USERNAME, "/SOC_comparison/soilgrids_diff_abs_kgm2"
    )
    diff_img <- rgee::ee$Image(diff_asset)

    # Stratified random sample: 10,000 points drawn uniformly across Canada.
    # seed = 42 ensures reproducibility and allows joining with other samples.
    sample_fc <- diff_img$sample(
      region    = diff_img$geometry(),
      scale     = 250,
      numPixels = 10000,
      seed      = 42
    )
    pixel_df <- rgee::ee_as_sf(sample_fc)
    message("Pixel sample extracted: ", nrow(pixel_df), " points")

    # Load reference stock from the same asset collection.
    ref_asset <- paste0(
      "users/", GEE_USERNAME, "/SOC_comparison/sothe_stock_kgm2"
    )
    ref_img   <- rgee::ee$Image(ref_asset)
    ref_fc    <- ref_img$sample(
      region    = ref_img$geometry(),
      scale     = 250,
      numPixels = 10000,
      seed      = 42  # same seed → same spatial locations as diff sample
    )
    ref_df <- rgee::ee_as_sf(ref_fc)

    # Combine: both samples use the same seed and region, so rows correspond.
    if (nrow(pixel_df) == nrow(ref_df)) {
      scatter_df <- data.frame(
        sothe_kgm2      = as.numeric(ref_df[[1]]),
        diff_abs_kgm2   = as.numeric(pixel_df[[1]])
      )
      scatter_df$soilgrids_kgm2 <- scatter_df$sothe_kgm2 + scatter_df$diff_abs_kgm2

      p_scatter <- ggplot2::ggplot(
        scatter_df,
        ggplot2::aes(x = sothe_kgm2, y = soilgrids_kgm2)
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
          title    = "Pixel-level scatter: Sothe vs. SoilGrids",
          subtitle = "n = 10,000 random sample  |  red dashed line = 1:1",
          x        = paste0("Sothe SOC (", UNIT_LABEL, ")"),
          y        = paste0("SoilGrids SOC (", UNIT_LABEL, ")")
        ) +
        ggplot2::theme_bw(base_size = 11)

      out_scatter <- file.path(OUTPUT_DIR, "scatter_sothe_vs_soilgrids.png")
      ggplot2::ggsave(out_scatter, p_scatter, width = 7, height = 6, dpi = 150)
      message("Saved: ", out_scatter)
      print(p_scatter)

    } else {
      message(
        "rgee: sample sizes differ (ref=", nrow(ref_df),
        ", diff=", nrow(pixel_df), ") — skipping scatter plot."
      )
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

# ADR 0004 — Electron first for Windows shipping

**Status:** Accepted for v1; revisit after stability data exists.

## Decision

Use Electron initially for both editor shell and exported Windows game shell.

## Why

Pinned Chromium behavior and strong automation/testing support are more valuable to a new 3D engine than a smaller installer.

## Revisit trigger

Evaluate Tauri/WebView2 or another shell after representative complete games provide real startup, memory, GPU, packaging and compatibility measurements.

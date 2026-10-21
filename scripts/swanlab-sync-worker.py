#!/usr/bin/env python3
"""
scripts/swanlab-sync-worker.py
SwanLab sync worker for lab-monitor.
Accepts a JSON payload file or '-' for stdin.
Initializes run, logs scalar & summary metrics, and calls swanlab.finish().
Outputs JSON result to stdout: {"success": True, "runId": "...", "runUrl": "..."}
"""
import sys
import os
import json

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Missing input payload file or argument"}))
        sys.exit(1)

    input_arg = sys.argv[1]
    try:
        if input_arg == "-":
            data = json.load(sys.stdin)
        else:
            with open(input_arg, "r", encoding="utf-8") as f:
                data = json.load(f)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Failed to parse input JSON: {e}"}))
        sys.exit(1)

    try:
        import swanlab
    except ImportError as e:
        print(json.dumps({"success": False, "error": f"swanlab is not installed: {e}"}))
        sys.exit(1)

    api_key = data.get("apiKey")
    project = data.get("project") or "lab-monitor"
    workspace = data.get("workspace")
    log_dir = data.get("logDir")
    mode = data.get("mode") or ("cloud" if api_key else "local")
    experiment_name = data.get("experimentName")
    description = data.get("description")
    config = data.get("config") or {}
    series_available = bool(data.get("seriesAvailable"))
    series = data.get("series") or []
    summary = data.get("summary") or {}

    # Login with api_key if provided
    if api_key:
        try:
            swanlab.login(api_key=api_key, save=False)
        except Exception as e:
            print(json.dumps({"success": False, "error": f"SwanLab login failed: {e}"}))
            sys.exit(1)

    # Prepare init kwargs
    init_kwargs = {
        "project": project,
        "name": experiment_name,
        "description": description,
        "config": config,
    }
    if log_dir:
        init_kwargs["log_dir"] = log_dir
    if workspace:
        init_kwargs["workspace"] = workspace
    if mode in ("local", "offline", "disabled"):
        init_kwargs["mode"] = mode

    run = None
    try:
        run = swanlab.init(**init_kwargs)

        # Log time-series if seriesAvailable
        if series_available and isinstance(series, list):
            for item in series:
                step = item.get("step")
                metrics = item.get("metrics")
                if metrics and isinstance(metrics, dict):
                    if step is not None:
                        swanlab.log(metrics, step=int(step))
                    else:
                        swanlab.log(metrics)

        # Always log summary metrics
        summary_metrics = {}
        if summary.get("gpuUtilMax") is not None:
            summary_metrics["lab-monitor/summary.gpu_util_max"] = summary["gpuUtilMax"]
        if summary.get("gpuUtilAvg") is not None:
            summary_metrics["lab-monitor/summary.gpu_util_avg"] = summary["gpuUtilAvg"]
        if summary.get("memPeak") is not None:
            summary_metrics["lab-monitor/summary.mem_peak"] = summary["memPeak"]
        if summary.get("groupCpuMax") is not None:
            summary_metrics["lab-monitor/summary.group_cpu_max"] = summary["groupCpuMax"]
        if summary.get("durationSec") is not None:
            summary_metrics["lab-monitor/summary.duration_sec"] = summary["durationSec"]

        if summary_metrics:
            swanlab.log(summary_metrics)

        run_id = getattr(run, "id", None)
        run_url = None
        try:
            run_url = getattr(run, "url", None) or getattr(run, "public_url", None)
        except Exception:
            pass

        if not run_url and run_id and workspace:
            run_url = f"https://swanlab.cn/@{workspace}/{project}/runs/{run_id}"

        swanlab.finish()

        print(json.dumps({
            "success": True,
            "runId": run_id,
            "runUrl": run_url,
        }))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()

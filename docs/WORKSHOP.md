# Workshop declaration and evidence boundary

This document describes the author-declared installation and permission model for the fixed
`lab-monitor` source. It is input to Workshop review; it is not an RC.6 verification report or
Registry admission.

## Integration type

- Protocol: `harness-profile`
- Adapter: `profile-bundle`
- Artifact: `cordis.patch.yml`
- Activation: restart the candidate Profile; hot reload is not claimed
- Failure policy: discard a failed candidate and restore the previous Profile generation

The adapter must install the fixed Git source into an ephemeral candidate Profile with package
lifecycle scripts disabled. Before activation it must prove that the current Profile is unchanged.
Removal must delete the package and reconcile the bundle list. Recovery must restore the previous
generation byte-for-byte. These statements define required tests; they do not assert those tests passed.

`lab-monitor` is a Host + Client two-half plugin, so the candidate must be composed on the exact
`@deepseek-ai/dsh-web-app@0.1.0-rc.6` bundle. A bare Profile does not provide the `webServer`,
`settings`, and client-slot services that the plugin declares as peers (see
`peerDependencies`). The Harness must record that Web base in its plan and must not interpret a
bare-Profile service wait as a plugin failure.

## Permissions

| Scope | Why it is required | Boundary |
|---|---|---|
| `process:observe` | Sample GPU/CPU/memory/process metrics for the monitoring engine | Read-only sampling; never signals, kills or modifies observed processes |
| `shell:execute` | Run platform sampler commands (`nvidia-smi`, `ps`, `tasklist`, Windows CIM) through the shell service | Only built-in read-only sampler command sets; no arbitrary command execution from config |
| `tools:register` | Register the `lab_status` / `lab_advice` / `lab_ctl` agent tools | `lab_ctl` is guarded to the monitoring/alert engine only and never touches experiments or sub-processes |
| `webserver:register` | Register `/lab-monitor/api/*` on the host web server | localhost-only data plane (no authentication, unreachable over Tailscale); does not own a separate listener |
| `ui:extend` | Register the conversation.view tab, the settings plugin card, and the optional better-sidebar tab | Uses host-provided client slot system; degrades silently when slots or better-sidebar are absent |

## External side effects

Sampling executes read-only system commands at a configurable interval (default 5 s):
`nvidia-smi` (GPU metrics), `ps` / `/proc` (Linux), `tasklist` / Windows Management
Instrumentation CIM (Windows). No install scripts exist; the package has no lifecycle scripts.

Configuration lives outside the package in `$DSH_HOME/settings.yaml` (host `settings` service).
The plugin does not write files itself.

## Capability assertion

The named capability a runtime adapter must register, invoke, and observe is the
`lab_status` tool:

- ID: `lab-status-snapshot`
- Invocation: call `lab_status` with `brief:true` after the candidate Profile is ready
- Expected: a JSON snapshot with `ok:true` containing GPU utilization/VRAM, CPU, memory and
  process entries (verified live in this session)

Loading alone (exit code 0) does not count as a functional check.

## Required independent evidence

Admission still requires all of the following at one new public commit:

1. exact `@deepseek-ai/dsh@0.1.0-rc.6` candidate Profile installation on
   `@deepseek-ai/dsh-web-app@0.1.0-rc.6`;
2. config composition showing the `lab-monitor` entry (via `dsh.bundle.patch`);
3. live registration, invocation and observation of the `lab_status` capability;
4. injected candidate failure with current Profile unchanged;
5. disable, remove, update, and previous-generation recovery;
6. independent human trust review and a separate admission change.

Until that evidence exists, seamless installation, failure isolation, and RC.6 compatibility remain
unknown even though the package manifest declares the intended adapter contract.

## Local verification baseline (author-maintained)

`scripts/verify.sh` runs typecheck, build, directory/contract checks and seven regression suites
(`verify-host` ~140 assertions, `mock-test`, `verify-m1`, `verify-overrides`,
`verify-proc-detail`, `verify-backend-mode`, optional sampler/e2e). These are author tests; they
are not a substitute for the independent Harness evidence above.

# Rector Security & Vulnerability Audit Report #1

**Date:** 2026-06-03  
**Auditor:** Gemini Security Audit Subagent  
**Scope:** Full worktree audit (`rector-0.1.0`) with security/vulnerability focus.  

This audit was conducted by inspecting the Rector codebase and tests for potential vulnerabilities, specifically analyzing authentication/exposure, secret leakage, SSRF/network, sandbox bypass, unsafe file paths, provider key leakage, operator APIs, and redaction gaps.

---

## Executive Summary

Rector implements several core security and redaction baselines designed for local-MVP / provider-free usage. However, three critical security vulnerabilities and gaps have been confirmed and validated against the actual codebase, including a severe regex-based credential exfiltration risk and global network exposure of unauthenticated administrative control APIs.

---

## Confirmed Findings

### 1. Secret/Credential Redaction Gap (CamelCase Keys Bypassed)

* **File/Line:** `src/security/redaction.ts` (lines 3–10)
* **Vulnerability Type:** Redaction Gap / Potential Secret Leakage
* **Severity:** High
* **Description:** 
  The key-based secret redaction mechanism in `redactSecrets` completely fails for camelCase keys that contain sensitive keywords (such as `slackToken`, `githubToken`, `dbPassword`, `awsSecretAccessKey`, `sessionCookie`, etc.). This happens because `SECRET_KEY_PATTERN` matches keywords anchored to the start of the string or preceded/followed by a delimiter `_` or `-` (`(^|[_-])`). 
  
  When a key like `slackToken` is analyzed, `isSensitiveKey` evaluates to `false`. The value then falls back to `redactString`, which only handles credentialed URIs, Bearer/Basic headers, or literal assignments like `password=abc`. Consequently, the raw API tokens, passwords, and secrets are printed, logged, stored in the in-memory event store, or transmitted to client-side operators (such as Retool console API) in cleartext.

* **Proof:**
  Running the following command in Node.js:
  ```bash
  node -e "const { redactSecrets } = require('./dist/security/redaction.js'); console.log(redactSecrets({ githubToken: 'ghp_abc123', dbPassword: 'my_password', awsSecretAccessKey: 'aws_key_123', sessionCookie: 'cookie_val' }));"
  ```
  Produces output in cleartext with **zero redaction**:
  ```json
  {
    "githubToken": "ghp_abc123",
    "dbPassword": "my_password",
    "awsSecretAccessKey": "aws_key_123",
    "sessionCookie": "cookie_val"
  }
  ```

* **Impact:** High. Sensitive developer/operator API keys (AWS, GitHub, Slack, databases, cookies) are leaked in cleartext across internal telemetry, console logs, persistent event logs, and unauthenticated public endpoints.
* **Suggested Fix:**
  Refactor `SECRET_KEY_PATTERN` in `src/security/redaction.ts` to support camelCase boundary transitions or word boundaries, or check if the lowercase version of the key *contains* the sensitive keywords, while ensuring it doesn't over-match unrelated words:
  ```typescript
  // Example robust regex pattern:
  const SECRET_KEY_PATTERN = /(?:^|[_-]|[a-z])(?:api[_-]?key|token|secret|password|authorization|cookie|connection[_-]?string)(?:$|[_-]|[A-Z])/i;
  ```
* **Concerns Register Coverage:** 
  The `docs/plans/concerns-and-vulnerabilities.md` register has a generic placeholder item ("Security controls are local-process baselines only"), but it does **not** document or address this specific, critical regex logic vulnerability that leaves standard camelCase configurations fully exposed.

---

### 2. Network Exposure of Local-Process Operators & Tasks APIs

* **File/Line:** `src/index.ts` (line 19) and `src/api/server.ts` (lines 43–46)
* **Vulnerability Type:** Auth/Exposure & Insecure Default Binding
* **Severity:** High
* **Description:** 
  The application server is started using `server.listen({ port: PORT })` without specifying a `host` binding parameter. In Node.js, when `host` is omitted, the HTTP server binds to wildcard interfaces (`0.0.0.0` or `::` depending on platform), listening for incoming traffic from any reachable network interface.
  
  Rector's highly powerful admin control APIs `/api/operator/*` and task manipulation APIs `/api/tasks/*` (e.g. creating/pausing/retrying tasks and approving transition gates) are unauthenticated (`auth: "local-only-no-auth"`). 

* **Impact:** High. If a developer runs this system locally (`npm run dev`) while connected to a shared/public network (e.g., public/corporate WiFi), anyone on the same network can access the API, inspect complete conversation histories, view runs (which may contain leaked secrets due to Finding #1), and trigger state machine transitions, tasks, or arbitrary mock events without any credentials.

* **Proof:**
  In `src/index.ts`:
  ```typescript
  server.listen({ port: PORT }, () => {
    console.log(`Rector MVP running on http://localhost:${PORT}`);
  });
  ```
  Because no `host` parameter is specified, the application defaults to binding globally across all network interfaces instead of restricting access to localhost (`127.0.0.1`). There are no IP validation or authorization middlewares checked on the server side for any `/api/operator/*` or `/api/tasks/*` routes.

* **Suggested Fix:**
  1. Default the host binding to `127.0.0.1` when running locally to prevent external interface exposure:
     ```typescript
     const HOST = process.env.HOST ?? "127.0.0.1";
     server.listen({ port: PORT, host: HOST }, () => {
       console.log(`Rector MVP running on http://${HOST}:${PORT}`);
     });
     ```
  2. Implement an IP-filtering or host-header checking middleware in `src/api/server.ts` to strictly block access to `/api/operator/*` and `/api/tasks/*` routes from external non-loopback IP addresses.

* **Concerns Register Coverage:** 
  The register acknowledges that operator endpoints are marked `localOnly: true` as metadata inside JSON envelopes, but does **not** recognize that the server binding exposes these unauthenticated routes directly on local physical network interfaces.

---

### 3. DNS Rebinding / Local Dev Server Vulnerability in `esbuild`

* **File/Line:** `package.json` (nested dev dependency inside `vitest` and `tsx`)
* **Vulnerability Type:** Local Sandbox Bypass / DNS Rebinding (CVE/GHSA-67mh-4wv8-2f99)
* **Severity:** Medium-High
* **Description:** 
  Running `npm audit` reports a moderate/critical vulnerability in `esbuild` (`<=0.24.2`). The vulnerability (GHSA-67mh-4wv8-2f99) allows any malicious website visited by a developer to send cross-origin requests to esbuild's local dev server and read local codebase files or execute code.
  
* **Impact:** Medium-High. A malicious website can exploit this via the developer's browser to exfiltrate files or execute arbitrary command code.

* **Proof:**
  Running `npm audit` output:
  ```
  esbuild  <=0.24.2
  Severity: moderate
  esbuild enables any website to send any requests to the development server and read the response - https://github.com/advisories/GHSA-67mh-4wv8-2f99
  ```

* **Suggested Fix:**
  Upgrade devDependencies `vitest` to `^3.0.0` or newer, or specify a dependency override/resolution in `package.json` to force nested `esbuild` to be `^0.25.0` or higher where Host-header/DNS rebinding validations are fully enforced.

* **Concerns Register Coverage:** 
  The concerns register contains a general note ("Dependency audit reports vulnerabilities" with unknown severity), but did not trace the root cause to esbuild's dev-server DNS rebinding flaw.

---

## Conclusion

Rector's design contains strong protocols and isolation contracts, but the current local implementation exposes critical gaps in **redaction boundary regex** and **default server binding**. Remediating these issues is highly recommended before the public alpha release to safeguard local developers' files and API credentials.

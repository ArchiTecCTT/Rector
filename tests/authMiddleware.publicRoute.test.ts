import { describe, expect, it } from "vitest";
import { isPublicAuthRoute } from "../src/security/authMiddleware";

describe("isPublicAuthRoute", () => {
  it("pins the auth middleware public-route allowlist", () => {
    const cases = [
      { method: "GET", path: "/", expected: true },
      { method: "POST", path: "/api/auth/login", expected: true },
      { method: "GET", path: "/api/setup/status", expected: true },
      { method: "GET", path: "/app.css", expected: true },
      { method: "GET", path: "/api/runs", expected: false },
      { method: "POST", path: "/api/setup/status", expected: false },
      { method: "GET", path: "/api/auth/login", expected: false },
    ];

    for (const routeCase of cases) {
      expect(isPublicAuthRoute(routeCase.method, routeCase.path)).toBe(routeCase.expected);
    }
  });
});

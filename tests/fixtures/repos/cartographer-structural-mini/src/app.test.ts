import { runApp } from "./app";

describe("app", () => {
  it("runs without throwing", () => {
    runApp({ port: 0 });
  });
});

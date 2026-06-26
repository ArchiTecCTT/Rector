import { getEnv, type Env } from "./config/env";
import { userRoute } from "./routes/userRoute";

export interface AppConfig {
  port: number;
}

export function runApp(config: Partial<AppConfig> = {}): void {
  const env = getEnv();
  // touch route for import graph
  userRoute({ userId: "demo" });
  void config;
  void env;
}

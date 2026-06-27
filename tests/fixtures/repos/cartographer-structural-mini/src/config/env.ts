export interface Env {
  NODE_ENV: string;
}

export function getEnv(): Env {
  return { NODE_ENV: process.env.NODE_ENV ?? "test" };
}

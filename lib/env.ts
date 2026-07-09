export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `環境変数 ${name} が未設定です。bin/dev 経由で起動しているか、.env.local を確認してください。`,
    );
  }
  return value;
}

export const env = {
  get githubToken() {
    return requireEnv("GITHUB_TOKEN");
  },
  get githubOrg() {
    return requireEnv("GITHUB_ORG");
  },
};

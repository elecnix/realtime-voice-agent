import fs from "node:fs";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const force = args.has("--force");

const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath) && !force) {
  throw new Error(".env already exists. Re-run with --force to overwrite, or edit it manually.");
}

const openaiApiKey = process.env.OPENAI_API_KEY ?? "";
const envContent = `OPENAI_API_KEY=${openaiApiKey}\nSERVER_PORT=8643\nCLIENT_PORT=8642\n`;

fs.writeFileSync(envPath, envContent, { encoding: "utf8", mode: 0o600 });

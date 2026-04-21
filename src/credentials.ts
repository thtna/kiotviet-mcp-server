import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The config file will be stored in the root of the kiotviet-mcp-server folder
const CONFIG_FILE = path.join(__dirname, "..", "kv_credentials.json");

interface KiotVietCredentials {
  clientId: string;
  clientSecret: string;
  retailer: string;
}

export function saveCredentials(creds: KiotVietCredentials): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(creds, null, 2), "utf8");
}

export function getCredentials(): KiotVietCredentials | null {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    const data = fs.readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    console.error("Lỗi khi đọc file KiotViet credentials:", err);
    return null;
  }
}

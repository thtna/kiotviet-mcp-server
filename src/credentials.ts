import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The config file will be stored in the root of the kiotviet-mcp-server folder
const CONFIG_FILE = path.join(__dirname, "..", "kv_credentials.json");

interface KiotVietAccount {
  clientId: string;
  clientSecret: string;
  type: "retail" | "fnb";
}

interface MultiKiotVietCredentials {
  defaultRetailer: string;
  accounts: Record<string, KiotVietAccount>;
}

export function saveCredentials(retailer: string, clientId: string, clientSecret: string, type: "retail" | "fnb" = "retail"): void {
  let config: MultiKiotVietCredentials = { defaultRetailer: retailer, accounts: {} };
  
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch (e) { /* ignore corrupt config */ }
  }

  config.accounts[retailer] = { clientId, clientSecret, type };
  config.defaultRetailer = retailer;
  
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

export function getAccount(retailer?: string): (KiotVietAccount & { retailer: string }) | null {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    const config: MultiKiotVietCredentials = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const name = retailer || config.defaultRetailer;
    const account = config.accounts[name];
    if (!account) return null;
    return { ...account, retailer: name };
  } catch (err) {
    return null;
  }
}

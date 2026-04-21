import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { saveCredentials, getAccount } from "./credentials.js";
import { resilientKiotVietAPI } from "./immune-system.js";
import { uploadInvoiceToVault } from "./github-vault.js";

const server = new Server(
  { name: "kiotviet-mcp-server", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "kv_setup_credentials",
      description: "Cấu hình KiotViet Client ID, Client Secret cho một gian hàng cụ thể.",
      inputSchema: {
        type: "object",
        properties: {
          clientId: { type: "string" },
          clientSecret: { type: "string" },
          retailer: { type: "string", description: "Tên gian hàng (ví dụ: bunmochoangyen)" },
          type: { type: "string", enum: ["retail", "fnb"], default: "retail", description: "Loại gian hàng (Bán lẻ hoặc Nhà hàng)" }
        },
        required: ["clientId", "clientSecret", "retailer"]
      }
    },
    {
      name: "kv_upload_invoice_to_vault",
      description: "Tải ảnh hóa đơn lên kho lưu trữ riêng tư trên GitHub.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Đường dẫn tuyệt đối đến file ảnh" },
          retailer: { type: "string", description: "Tên gian hàng để phân loại thư mục (tùy chọn)" }
        },
        required: ["filePath"]
      }
    },
    {
      name: "kv_sync_products",
      description: "Đồng bộ hàng hóa: Kiểm tra hàng đã có chưa, nếu chưa thì tự động tạo mới.",
      inputSchema: {
        type: "object",
        properties: {
          retailer: { type: "string", description: "Tên gian hàng cần thực hiện" },
          products: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Tên hàng hóa" },
                price: { type: "number", description: "Giá nhập/Giá vốn" },
                code: { type: "string", description: "Mã hàng (nếu có)" }
              },
              required: ["name", "price"]
            }
          }
        },
        required: ["products"]
      }
    },
    {
      name: "kv_create_purchase_order",
      description: "Lập phiếu nhập hàng chính thức lên KiotViet.",
      inputSchema: {
        type: "object",
        properties: {
          retailer: { type: "string", description: "Tên gian hàng cần thực hiện" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                productCode: { type: "string", description: "Mã hàng hóa chuẩn trên KiotViet" },
                quantity: { type: "number", description: "Số lượng nhập" },
                price: { type: "number", description: "Giá nhập thực tế" }
              },
              required: ["productCode", "quantity", "price"]
            }
          },
          totalPayment: { type: "number", description: "Tổng tiền hóa đơn để đối chiếu (Checksum)" }
        },
        required: ["items", "totalPayment"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};
  const currentRetailer = args.retailer as string;

  try {
    switch (request.params.name) {
      case "kv_setup_credentials": {
        saveCredentials(
          args.retailer as string,
          args.clientId as string,
          args.clientSecret as string,
          (args.type as "retail" | "fnb") || "retail"
        );
        return { content: [{ type: "text", text: `Đã thiết lập gian hàng [${args.retailer}] thành công.` }] };
      }

      case "kv_upload_invoice_to_vault": {
        const filePath = args.filePath as string;
        const htmlUrl = await uploadInvoiceToVault(filePath, currentRetailer);
        return { content: [{ type: "text", text: `Hóa đơn đã được lưu tại Vault: ${htmlUrl}` }] };
      }

      case "kv_sync_products": {
        const productsList = args.products as any[];
        const syncResults = [];

        for (const item of productsList) {
          // 1. Tìm sản phẩm
          const searchData: any = await resilientKiotVietAPI("GET", `/products?name=${encodeURIComponent(item.name)}&pageSize=10`, null, currentRetailer);
          let product = searchData.data?.find((p: any) => p.name.toLowerCase() === item.name.toLowerCase() || p.fullName.toLowerCase() === item.name.toLowerCase());

          if (product) {
            syncResults.push({ name: item.name, status: "exists", productCode: product.code });
          } else {
            console.warn(`[Smart-Entry] Tạo mới hàng hóa: ${item.name}`);
            const payload = {
              name: item.name,
              code: item.code || `AI_${Date.now().toString().slice(-6)}`,
              basePrice: item.price,
              isActive: true,
              productType: 1
            };
            const createRes: any = await resilientKiotVietAPI("POST", "/products", payload, currentRetailer);
            syncResults.push({ name: createRes.name, status: "created", productCode: createRes.code });
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(syncResults, null, 2) }] };
      }

      case "kv_create_purchase_order": {
        const items = args.items as any[];
        const expectedTotal = args.totalPayment as number;

        // Bác sĩ kiểm tra độc lập (Checksum)
        let calculatedTotal = 0;
        const details = items.map(i => {
          calculatedTotal += (i.quantity * i.price);
          return { productCode: i.productCode, quantity: i.quantity, price: i.price };
        });

        if (Math.abs(calculatedTotal - expectedTotal) > 1) { // Lệch quá 1 đồng thì chặn
          return { content: [{ type: "text", text: `[HỆ MIỄN DỊCH] Sai số tổng tiền! Thớt tính ${calculatedTotal}, Hóa đơn ${expectedTotal}.` }], isError: true };
        }

        const branchData: any = await resilientKiotVietAPI("GET", "/branches?pageSize=1", null, currentRetailer);
        const branchId = branchData.data?.[0]?.id;

        const payload = {
          branchId,
          purchaseDate: new Date().toISOString(),
          status: 1, // Hoàn thành
          purchaseOrderDetails: details
        };

        const result: any = await resilientKiotVietAPI("POST", "/purchaseorders", payload, currentRetailer);
        return { content: [{ type: "text", text: `Nhập hàng thành công! Mã phiếu: ${result.code}` }] };
      }

      default:
        throw new Error(`Tool không tồn tại: ${request.params.name}`);
    }
  } catch (error: any) {
    return { content: [{ type: "text", text: `[Lỗi Hệ Thống] ${error.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("KiotViet MCP Server v1.1 Multi-Tenant is running.");
}

main().catch(console.error);

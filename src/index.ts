import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { saveCredentials, getCredentials } from "./credentials.js";
import { resilientKiotVietAPI } from "./immune-system.js";
import { uploadInvoiceToVault } from "./github-vault.js";

const server = new Server(
  { name: "kiotviet-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "kv_setup_credentials",
      description: "Cấu hình KiotViet Client ID, Client Secret và Tên gian hàng.",
      inputSchema: {
        type: "object",
        properties: {
          clientId: { type: "string" },
          clientSecret: { type: "string" },
          retailer: { type: "string", description: "Tên gian hàng KiotViet (ví dụ: bunmochoangyen)" }
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
          filePath: { type: "string", description: "Đường dẫn tuyệt đối đến file ảnh trên máy tính" }
        },
        required: ["filePath"]
      }
    },
    {
      name: "kv_sync_products",
      description: "Đồng bộ hàng hóa: Kiểm tra hàng đã có trên KiotViet chưa, nếu chưa thì tạo mới.",
      inputSchema: {
        type: "object",
        properties: {
          products: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Tên hàng hóa" },
                price: { type: "number", description: "Giá nhập" },
                code: { type: "string", description: "Mã hàng (tùy chọn)" }
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
      description: "Tạo phiếu nhập hàng (Purchase Order) với tổng số tiền.",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                productCode: { type: "string", description: "Mã hàng hóa trên KiotViet" },
                quantity: { type: "number", description: "Số lượng nhập" },
                price: { type: "number", description: "Giá nhập" }
              },
              required: ["productCode", "quantity", "price"]
            }
          },
          totalPayment: { type: "number", description: "Tổng số tiền cần trả (để Hệ Miễn dịch đối chiếu)" }
        },
        required: ["items", "totalPayment"]
      }
    }
  ]
}));

// Xử lý các lệnh gọi Tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};

  try {
    switch (request.params.name) {
      case "kv_setup_credentials": {
        saveCredentials({
          clientId: args.clientId as string,
          clientSecret: args.clientSecret as string,
          retailer: args.retailer as string
        });
        return { content: [{ type: "text", text: "Thiết lập cấu hình KiotViet thành công. Thông tin đã được lưu cục bộ an toàn." }] };
      }

      case "kv_upload_invoice_to_vault": {
        const filePath = args.filePath as string;
        const htmlUrl = await uploadInvoiceToVault(filePath);
        return { content: [{ type: "text", text: `Upload thành công! Hóa đơn đã được lưu tại: ${htmlUrl}` }] };
      }

      case "kv_sync_products": {
        const productsList = args.products as any[];
        const results = [];

        for (const item of productsList) {
          // 1. Tìm sản phẩm trên KiotViet bằng tên
          const searchData: any = await resilientKiotVietAPI("GET", `/products?name=${encodeURIComponent(item.name)}&pageSize=10`);
          
          let product = searchData.data?.find((p: any) => p.name.toLowerCase() === item.name.toLowerCase() || p.fullName.toLowerCase() === item.name.toLowerCase());

          if (product) {
            results.push({ name: item.name, status: "exists", productCode: product.code, id: product.id });
          } else {
            // 2. Không tìm thấy -> Tạo sản phẩm mới
            console.warn(`[KiotViet MCP] Sản phẩm mới: "${item.name}". Tiến hành tạo...`);
            const createPayload = {
              name: item.name,
              code: item.code || `SP_${Date.now().toString().slice(-6)}`,
              basePrice: item.price,
              inventories: [{ branchId: null, cost: item.price, onHand: 0 }] // Khởi tạo tồn kho bằng 0
            };
            
            const createRes: any = await resilientKiotVietAPI("POST", `/products`, createPayload);
            results.push({ name: createRes.name, status: "created", productCode: createRes.code, id: createRes.id });
          }
        }
        
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      case "kv_create_purchase_order": {
        const items = args.items as any[];
        const expectedTotal = args.totalPayment as number;

        // Bác sĩ kiểm tra độc lập - Hệ Miễn Dịch (Check sum)
        let calculatedTotal = 0;
        const purchaseOrderDetails = items.map(item => {
          calculatedTotal += (item.quantity * item.price);
          return {
            productCode: item.productCode,
            quantity: item.quantity,
            price: item.price
          }
        });

        if (Math.abs(calculatedTotal - expectedTotal) > Number.EPSILON) {
          // Báo lệch giá! Không nhập để tránh sai số kiểm toán
          return {
            content: [{ type: "text", text: `[HỆ MIỄN DỊCH CHẶN LẠI] Cảnh báo lỗi toán học: Tổng tiền cung cấp (${expectedTotal}) KHÔNG KHỚP với tổng tiền tính toán (${calculatedTotal}). Vui lòng kiểm tra lại AI OCR.` }],
            isError: true
          };
        }

        // Lấy danh sách Branch ID (KiotViet bắt buộc có Branch để nhập kho)
        const branchData: any = await resilientKiotVietAPI("GET", "/branches?pageSize=1");
        if (!branchData.data || branchData.data.length === 0) {
          throw new Error("Không lấy được thông tin Chi Nhánh (Branch) của cửa hàng.");
        }
        const branchId = branchData.data[0].id;

        const payload = {
          branchId: branchId,
          purchaseDate: new Date().toISOString(),
          status: 1, // 1 = Hoàn thành (nhập luôn kho)
          purchaseOrderDetails: purchaseOrderDetails
        };

        const result: any = await resilientKiotVietAPI("POST", "/purchaseOrders", payload);

        return { content: [{ type: "text", text: `Tạo Phiếu Nhập Hàng thành công! Mã phiếu: ${result.code}, ID: ${result.id}, Tổng tiền: ${result.totalPayment}` }] };
      }

      default:
        throw new Error(`Công cụ không được hỗ trợ: ${request.params.name}`);
    }
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `[Lỗi Lõi] ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("KiotViet MCP Server v1.0 (Immune System Enabled) is running over stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

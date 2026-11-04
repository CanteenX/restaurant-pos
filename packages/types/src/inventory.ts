import { z } from "zod";
import { paymentMethodSchema } from "./orders";

export const ingredientUnitSchema = z.enum([
  "KG",
  "G",
  "L",
  "ML",
  "PIECE",
  "DOZEN",
  "PACK",
  "BOX",
]);
export type IngredientUnit = z.infer<typeof ingredientUnitSchema>;

// Base fields with NO defaults, shared by create and update (zod 4 keeps
// .default() inside .partial(), which would reset omitted fields on PATCH).
const ingredientFields = z.object({
  name: z.string().min(1),
  sku: z.string().optional(),
  unit: ingredientUnitSchema,
  reorderLevel: z.coerce.number().nonnegative(),
  // capped like the reorder `days` window (1..365)
  leadTimeDays: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(365)
    .nullable()
    .optional(),
  packSize: z.coerce.number().positive().nullable().optional(),
  preferredSupplierId: z.string().min(1).nullable().optional(),
  isActive: z.boolean(),
});

export const ingredientSchema = ingredientFields.extend({
  reorderLevel: ingredientFields.shape.reorderLevel.default(0),
  isActive: ingredientFields.shape.isActive.default(true),
});
export type IngredientDto = z.infer<typeof ingredientSchema>;

/** PATCH: only the fields sent are written; omitted fields keep their value. */
export const ingredientUpdateSchema = ingredientFields.partial();
export type IngredientUpdateDto = z.infer<typeof ingredientUpdateSchema>;

// Quantities on recipe lines, goods receipts, waste and adjustments may be
// entered in any unit convertible to the ingredient's base unit (KG<->G,
// L<->ML, DOZEN<->PIECE, or a pack size set on the ingredient). Omitted =
// the base unit. The server converts and stores base units only.
const enteredUnit = ingredientUnitSchema.optional();

export const unitConversionSchema = z.object({
  unit: ingredientUnitSchema,
  // How many base units one `unit` holds, e.g. PACK = 25 (KG). Stored as
  // DECIMAL(14,6), so at most 6 decimal places: anything finer would be
  // rounded (or zeroed) silently and skew every later conversion.
  factor: z.coerce
    .number()
    .min(0.000001)
    .max(1_000_000)
    .refine((v) => Number(v.toFixed(6)) === v, {
      message: "Use at most 6 decimal places",
    }),
});
export type UnitConversionDto = z.infer<typeof unitConversionSchema>;

export const setUnitConversionsSchema = z.object({
  conversions: z.array(unitConversionSchema).max(8),
});
export type SetUnitConversionsDto = z.infer<typeof setUnitConversionsSchema>;

export const stockAdjustmentSchema = z.object({
  quantity: z.coerce.number(), // signed: positive to add, negative to remove
  unit: enteredUnit,
  note: z.string().min(1),
});
export type StockAdjustmentDto = z.infer<typeof stockAdjustmentSchema>;

export const recipeLineSchema = z.object({
  ingredientId: z.string(),
  quantity: z.coerce.number().positive(),
  unit: enteredUnit,
});
export type RecipeLineDto = z.infer<typeof recipeLineSchema>;

export const setRecipeSchema = z.object({
  lines: z.array(recipeLineSchema),
});
export type SetRecipeDto = z.infer<typeof setRecipeSchema>;

export const inventoryTrackingSchema = z.enum(["NONE", "RECIPE", "DIRECT"]);
export type InventoryTrackingDto = z.infer<typeof inventoryTrackingSchema>;

// How selling a menu item moves stock (see InventoryTracking in schema.prisma).
export const menuItemTrackingSchema = z
  .object({
    inventoryTracking: inventoryTrackingSchema,
    stockIngredientId: z.string().min(1).nullable().optional(),
    stockQuantityPerSale: z.coerce.number().positive().max(100000).optional(),
  })
  .refine((v) => v.inventoryTracking !== "DIRECT" || !!v.stockIngredientId, {
    message: "Pick the stock item this product deducts from",
    path: ["stockIngredientId"],
  });
export type MenuItemTrackingDto = z.infer<typeof menuItemTrackingSchema>;

export const supplierSchema = z.object({
  name: z.string().min(1),
  contactName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  gstNumber: z.string().optional(),
  notes: z.string().optional(),
  isActive: z.boolean().default(true),
});
export type SupplierDto = z.infer<typeof supplierSchema>;

export const purchaseOrderItemSchema = z.object({
  ingredientId: z.string(),
  quantityOrdered: z.coerce.number().positive(),
  unitCost: z.coerce.number().nonnegative(),
});
export type PurchaseOrderItemDto = z.infer<typeof purchaseOrderItemSchema>;

export const purchaseOrderSchema = z.object({
  supplierId: z.string(),
  expectedDate: z.coerce.date().optional(),
  notes: z.string().optional(),
  items: z.array(purchaseOrderItemSchema).min(1),
});
export type PurchaseOrderDto = z.infer<typeof purchaseOrderSchema>;

export const purchaseOrderStatusSchema = z.enum([
  "DRAFT",
  "SENT",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CANCELLED",
]);
export type PurchaseOrderStatus = z.infer<typeof purchaseOrderStatusSchema>;

export const goodsReceiptItemSchema = z.object({
  ingredientId: z.string(),
  purchaseOrderItemId: z.string().optional(),
  quantity: z.coerce.number().positive(),
  unit: enteredUnit, // unit of both quantity and unitCost
  unitCost: z.coerce.number().nonnegative(),
  batchNumber: z.string().optional(), // auto-generated server-side if omitted
  expiryDate: z.coerce.date().optional(),
});
export type GoodsReceiptItemDto = z.infer<typeof goodsReceiptItemSchema>;

export const goodsReceiptSchema = z.object({
  supplierId: z.string(),
  purchaseOrderId: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(goodsReceiptItemSchema).min(1),
});
export type GoodsReceiptDto = z.infer<typeof goodsReceiptSchema>;

export const wasteReasonSchema = z.enum([
  "EXPIRED",
  "SPOILED",
  "DAMAGED",
  "PREP_ERROR",
  "OVER_PRODUCTION",
  "OTHER",
]);
export type WasteReason = z.infer<typeof wasteReasonSchema>;

export const wasteLogSchema = z.object({
  ingredientId: z.string(),
  quantity: z.coerce.number().positive(),
  unit: enteredUnit,
  reason: wasteReasonSchema,
  notes: z.string().optional(),
});
export type WasteLogDto = z.infer<typeof wasteLogSchema>;

// ---------------------------------------------------------------------------
// Procurement depth — purchase requests, supplier quotations, vendor invoices
// ---------------------------------------------------------------------------

export const purchaseRequestStatusSchema = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "CONVERTED",
]);
export type PurchaseRequestStatus = z.infer<typeof purchaseRequestStatusSchema>;

export const purchaseRequestItemSchema = z.object({
  ingredientId: z.string(),
  quantityRequested: z.coerce.number().positive(),
  notes: z.string().optional(),
});
export type PurchaseRequestItemDto = z.infer<typeof purchaseRequestItemSchema>;

export const purchaseRequestSchema = z.object({
  notes: z.string().optional(),
  items: z.array(purchaseRequestItemSchema).min(1),
});
export type PurchaseRequestDto = z.infer<typeof purchaseRequestSchema>;

export const quotationStatusSchema = z.enum([
  "DRAFT",
  "RECEIVED",
  "ACCEPTED",
  "REJECTED",
]);
export type QuotationStatus = z.infer<typeof quotationStatusSchema>;

export const supplierQuotationItemSchema = z.object({
  ingredientId: z.string(),
  quantityQuoted: z.coerce.number().positive(),
  unitPrice: z.coerce.number().nonnegative(),
});
export type SupplierQuotationItemDto = z.infer<
  typeof supplierQuotationItemSchema
>;

export const supplierQuotationSchema = z.object({
  supplierId: z.string(),
  validUntil: z.coerce.date().optional(),
  notes: z.string().optional(),
  items: z.array(supplierQuotationItemSchema).min(1),
});
export type SupplierQuotationDto = z.infer<typeof supplierQuotationSchema>;

export const supplierInvoiceStatusSchema = z.enum([
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
  "CANCELLED",
]);
export type SupplierInvoiceStatus = z.infer<typeof supplierInvoiceStatusSchema>;

export const supplierInvoiceSchema = z.object({
  supplierId: z.string(),
  purchaseOrderId: z.string().optional(),
  goodsReceiptId: z.string().optional(),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.coerce.date(),
  dueDate: z.coerce.date().optional(),
  totalAmount: z.coerce.number().positive(),
  notes: z.string().optional(),
});
export type SupplierInvoiceDto = z.infer<typeof supplierInvoiceSchema>;

export const supplierPaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  paymentMethod: paymentMethodSchema,
  reference: z.string().optional(),
});
export type SupplierPaymentDto = z.infer<typeof supplierPaymentSchema>;

export const reorderSuggestionsQuerySchema = z.object({
  branchId: z.string().min(1),
  days: z.coerce.number().int().min(1).max(365).default(30),
});
export type ReorderSuggestionsQuery = z.infer<
  typeof reorderSuggestionsQuerySchema
>;

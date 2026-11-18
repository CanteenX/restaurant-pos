import {
  AcceptanceStatus,
  OrderChannel,
  OrderStatus,
  OrderType,
} from '@prisma/client';
import { buildSchema } from 'graphql';

// Schema-first (SDL + per-request root resolvers on plain graphql-js), see
// docs/graphql-api.md. Resolvers live in graphql-resolvers.ts / resolvers/;
// each calls requireAccess() and filters by the credential's tenant. Every
// list field takes a page argument whose default equals the resolver's
// clampPage() defaultSize (the cost rule charges what the resolver loads).
const enumOf = (name: string, values: Record<string, string>) =>
  `enum ${name} { ${Object.values(values).join(' ')} }`;

export const typeDefs = /* GraphQL */ `
  enum PrincipalKind {
    INTEGRATION_KEY
    STAFF
  }
  ${enumOf('OrderStatus', OrderStatus)}
  ${enumOf('OrderType', OrderType)}
  ${enumOf('OrderChannel', OrderChannel)}
  ${enumOf('AcceptanceStatus', AcceptanceStatus)}

  "Who is calling, and which tenant every field in this request is scoped to."
  type Viewer {
    kind: PrincipalKind!
    id: ID!
    restaurantId: ID!
    "Set when an integration key is locked to one location."
    branchId: ID
    "Integration key scopes, or the staff member's permissions."
    grants: [String!]!
  }

  "Cursor pagination: pass endCursor back as after to get the next page."
  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type MenuCategory {
    id: ID!
    branchId: ID!
    name: String!
    sortOrder: Int!
    isActive: Boolean!
    showOnWebsite: Boolean!
  }

  type MenuItem {
    id: ID!
    branchId: ID!
    categoryId: ID!
    name: String!
    description: String
    imageUrl: String
    "Tax-inclusive. For integration keys, the website price (Settings online price change applied)."
    price: Float!
    taxRatePercent: Float!
    isVeg: Boolean!
    isVegan: Boolean!
    spiceLevel: String!
    allergens: [String!]!
    "HH:mm window the item can be ordered in, if set."
    availableFrom: String
    availableTo: String
    isActive: Boolean!
    category: MenuCategory
    "Staff with menu.manage only; null with a FORBIDDEN error for anyone else."
    costPrice: Float
  }

  type MenuCategoryConnection {
    nodes: [MenuCategory!]!
    pageInfo: PageInfo!
  }

  type MenuItemConnection {
    nodes: [MenuItem!]!
    pageInfo: PageInfo!
  }

  type OrderTotals {
    subtotal: Float!
    tax: Float!
    discount: Float!
    tip: Float!
    deliveryFee: Float!
    total: Float!
  }

  type OrderItemModifier {
    name: String!
    priceAdjustment: Float!
  }

  type OrderItem {
    id: ID!
    name: String!
    quantity: Int!
    unitPrice: Float!
    lineTotal: Float!
    kitchenNote: String
    modifiers(first: Int = 5): [OrderItemModifier!]!
  }

  "Customer details on an order (personal data)."
  type OrderCustomer {
    name: String
    phone: String
    email: String
  }

  type Order {
    id: ID!
    branchId: ID!
    orderNumber: String!
    type: OrderType!
    status: OrderStatus!
    channel: OrderChannel!
    acceptance: AcceptanceStatus!
    createdAt: String!
    scheduledFor: String
    notes: String
    totals: OrderTotals!
    items(first: Int = 10): [OrderItem!]!
    "Needs orders:read_customer (keys) or customers.manage (staff); otherwise null with a FORBIDDEN error."
    customer: OrderCustomer
  }

  type OrderConnection {
    nodes: [Order!]!
    pageInfo: PageInfo!
  }

  type Customer {
    id: ID!
    branchId: ID!
    name: String
    phone: String
    email: String
    loyaltyPoints: Int!
    createdAt: String!
  }

  type CustomerConnection {
    nodes: [Customer!]!
    pageInfo: PageInfo!
  }

  "One dish in a new order. Prices come from the live menu, never from you."
  input OrderItemInput {
    menuItemId: ID!
    "1 to 99."
    quantity: Int!
    modifierIds: [ID!]
    kitchenNote: String
  }

  "Required for DELIVERY orders. phone defaults to customerPhone."
  input DeliveryInput {
    address: String!
    pincode: String!
    phone: String
    "Send both lat and lng, or neither."
    lat: Float
    lng: Float
    place: String
  }

  "The REST Integration API order body (docs/integrations-api.md), minus rewards."
  input CreateOrderInput {
    "TAKEAWAY (default) or DELIVERY."
    type: OrderType
    customerName: String!
    customerPhone: String!
    customerEmail: String
    notes: String
    "ISO 8601, at least 10 minutes ahead (pre-order)."
    scheduledFor: String
    delivery: DeliveryInput
    "1 to 50 lines."
    items: [OrderItemInput!]!
  }

  "One mutation field per request."
  type Mutation {
    """
    Scope orders:write (integration keys only). Server-priced and tax-inclusive;
    the order waits for staff to accept it (acceptance PENDING). Reuse an
    idempotencyKey (8-64 of A-Z a-z 0-9 _ -) to retry safely: the same key
    with the same input returns the original order, with other input it is
    BAD_USER_INPUT. Keys are shared with the REST Idempotency-Key header.
    """
    createOrder(
      branchId: ID!
      input: CreateOrderInput!
      idempotencyKey: String
    ): Order!
    """
    Scope menu:availability / permission menu.manage. Marks a dish sold out
    (false) or back on (true); connected delivery platforms are updated.
    """
    setMenuItemAvailability(id: ID!, available: Boolean!): MenuItem!
  }

  type Query {
    viewer: Viewer!
    "Scope menu:read / permission menu.view. Ordered by sortOrder."
    menuCategories(
      branchId: ID
      first: Int = 50
      after: String
    ): MenuCategoryConnection!
    "Scope menu:read / permission menu.view. Ordered by sortOrder."
    menuItems(
      branchId: ID
      categoryId: ID
      first: Int = 50
      after: String
    ): MenuItemConnection!
    "Scope orders:read (only orders the key placed) / permission orders.create. Newest first."
    orders(
      branchId: ID
      status: OrderStatus
      first: Int = 10
      after: String
    ): OrderConnection!
    order(id: ID!): Order
    "Scope customers:read / permission customers.manage. Newest first."
    customers(
      branchId: ID
      search: String
      first: Int = 20
      after: String
    ): CustomerConnection!
    customer(id: ID!): Customer
  }
`;

export const schema = buildSchema(typeDefs);

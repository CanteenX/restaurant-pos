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

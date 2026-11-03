import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CustomerAddressDto,
  CustomerAddressUpdateDto,
  CustomerDto,
} from '@nventra/types';
import { AuditService } from '../../audit/audit.service';
import { diffFields } from '../../audit/audit-diff';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(branchId: string, search?: string) {
    return this.prisma.customer.findMany({
      where: {
        branchId,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(branchId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, branchId },
      include: {
        orders: {
          where: { status: 'PAID' },
          orderBy: { billedAt: 'desc' },
          take: 20,
          select: {
            id: true,
            orderNumber: true,
            totalAmount: true,
            billedAt: true,
          },
        },
        giftCards: true,
        addresses: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async create(branchId: string, dto: CustomerDto, userId?: string) {
    const created = await this.prisma.customer.create({
      data: { ...dto, branchId },
    });
    await this.audit.record({
      userId,
      action: 'customer.created',
      entity: 'Customer',
      entityId: created.id,
      metadata: { branchId, name: created.name },
    });
    return created;
  }

  async update(
    branchId: string,
    id: string,
    dto: Partial<CustomerDto>,
    userId?: string,
  ) {
    const existing = await this.assertInBranch(branchId, id);
    const updated = await this.prisma.customer.update({
      where: { id },
      data: dto,
    });
    await this.audit.record({
      userId,
      action: 'customer.updated',
      entity: 'Customer',
      entityId: id,
      metadata: {
        branchId,
        name: updated.name,
        changes: diffFields(existing, dto),
      },
    });
    return updated;
  }

  // Hard delete — Order.customerId and GiftCard.customerId are both
  // optional with onDelete: SetNull (schema.prisma), so this never orphans
  // or blocks on past orders/gift cards; it just detaches them from the
  // profile being removed.
  async remove(branchId: string, id: string, userId?: string) {
    const existing = await this.assertInBranch(branchId, id);
    await this.prisma.customer.delete({ where: { id } });
    await this.audit.record({
      userId,
      action: 'customer.deleted',
      entity: 'Customer',
      entityId: id,
      metadata: { branchId, name: existing.name },
    });
    return { ok: true };
  }

  // ---- Saved delivery addresses -------------------------------------------

  async listAddresses(branchId: string, customerId: string) {
    await this.assertInBranch(branchId, customerId);
    return this.prisma.customerAddress.findMany({
      where: { customerId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async addAddress(
    branchId: string,
    customerId: string,
    dto: CustomerAddressDto,
  ) {
    await this.assertInBranch(branchId, customerId);
    return this.prisma.$transaction(async (tx) => {
      const count = await tx.customerAddress.count({ where: { customerId } });
      // The first address is the default; asking for a new default demotes
      // the old one in the same transaction so there is only ever one.
      const isDefault = count === 0 || dto.isDefault === true;
      if (isDefault) {
        await tx.customerAddress.updateMany({
          where: { customerId },
          data: { isDefault: false },
        });
      }
      return tx.customerAddress.create({
        data: { ...dto, customerId, isDefault },
      });
    });
  }

  async updateAddress(
    branchId: string,
    customerId: string,
    addressId: string,
    dto: CustomerAddressUpdateDto,
  ) {
    await this.assertInBranch(branchId, customerId);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.customerAddress.findFirst({
        where: { id: addressId, customerId },
      });
      if (!existing) throw new NotFoundException('Address not found');
      if (dto.isDefault === true) {
        await tx.customerAddress.updateMany({
          where: { customerId, NOT: { id: addressId } },
          data: { isDefault: false },
        });
      }
      // Never leave a customer with addresses but no default.
      const data =
        dto.isDefault === false && existing.isDefault
          ? { ...dto, isDefault: true }
          : dto;
      return tx.customerAddress.update({ where: { id: addressId }, data });
    });
  }

  async removeAddress(branchId: string, customerId: string, addressId: string) {
    await this.assertInBranch(branchId, customerId);
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.customerAddress.findFirst({
        where: { id: addressId, customerId },
      });
      if (!existing) throw new NotFoundException('Address not found');
      await tx.customerAddress.delete({ where: { id: addressId } });
      if (existing.isDefault) {
        const next = await tx.customerAddress.findFirst({
          where: { customerId },
          orderBy: { createdAt: 'asc' },
        });
        if (next) {
          await tx.customerAddress.update({
            where: { id: next.id },
            data: { isDefault: true },
          });
        }
      }
    });
    return { ok: true };
  }

  private async assertInBranch(branchId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, branchId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }
}

import { BadRequestException, PipeTransform } from '@nestjs/common';
import { z } from 'zod';

const branchIdSchema = z.string().refine((value) => value.trim().length > 0);

export class RequiredBranchIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const parsed = branchIdSchema.safeParse(value);
    if (!parsed.success) throw new BadRequestException('branchId is required');
    return parsed.data;
  }
}

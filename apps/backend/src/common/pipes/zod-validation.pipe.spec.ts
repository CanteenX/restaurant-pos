import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

const schema = z.object({ branchId: z.string().min(1) });

describe('ZodValidationPipe', () => {
  it('validates the body by default and passes other params through', () => {
    const pipe = new ZodValidationPipe(schema);
    expect(() => pipe.transform({}, { type: 'body' })).toThrow(
      BadRequestException,
    );
    expect(pipe.transform('raw', { type: 'query' })).toBe('raw');
  });

  it('validates the query object when targeted at query', () => {
    const pipe = new ZodValidationPipe(schema, 'query');
    expect(() => pipe.transform({}, { type: 'query' })).toThrow(
      BadRequestException,
    );
    expect(() => pipe.transform({ branchId: '' }, { type: 'query' })).toThrow(
      BadRequestException,
    );
    expect(pipe.transform({ branchId: 'b1' }, { type: 'query' })).toEqual({
      branchId: 'b1',
    });
    expect(pipe.transform({}, { type: 'body' })).toEqual({});
  });
});

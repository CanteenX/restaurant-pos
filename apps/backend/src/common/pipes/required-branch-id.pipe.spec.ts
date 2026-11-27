import { BadRequestException } from '@nestjs/common';
import { RequiredBranchIdPipe } from './required-branch-id.pipe';

describe('RequiredBranchIdPipe', () => {
  const pipe = new RequiredBranchIdPipe();
  it.each([undefined, null, '', '   ', ['a', 'b']])('rejects %p', (value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
    expect(() => pipe.transform(value)).toThrow('branchId is required');
  });
  it('preserves a valid branch ID for the tenant check', () => {
    expect(pipe.transform('branch-1')).toBe('branch-1');
  });
});

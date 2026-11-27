import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { SessionUser } from '@nventra/types';
import { ReportSchedulesController } from './report-schedules.controller';
import type { ReportSchedulesService } from './report-schedules.service';
import type { EmailService } from '../email/email.service';
import type { BranchAccessService } from '../../common/services/branch-access.service';

describe('report schedule authorization', () => {
  const user = {
    restaurantId: 'restaurant',
    permissions: ['reports.access', 'data.export'],
  } as SessionUser;
  const schedules = {
    list: jest.fn(),
    get: jest.fn(),
    setActive: jest.fn(),
    sendNow: jest.fn(),
    remove: jest.fn(),
  };
  const branch = { assertAccess: jest.fn() };
  const controller = new ReportSchedulesController(
    schedules as unknown as ReportSchedulesService,
    { isConfigured: () => true } as EmailService,
    branch as unknown as BranchAccessService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    branch.assertAccess.mockResolvedValue(undefined);
    schedules.get.mockResolvedValue({ id: 'sales', reportKey: 'sales-daily' });
    schedules.list.mockResolvedValue([
      { id: 'sales', reportKey: 'sales-daily' },
      { id: 'waste', reportKey: 'waste' },
    ]);
  });

  it('filters inaccessible schedule details from listing', async () => {
    const result = await controller.list(user, 'branch');
    expect(result.schedules).toEqual([{ id: 'waste', reportKey: 'waste' }]);
  });

  it('checks the target permission before creating a sales schedule', async () => {
    await expect(
      controller.create(user, 'branch', {
        reportKey: 'sales-daily',
        frequency: 'DAILY',
        format: 'csv',
        recipients: ['test@example.com'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(branch.assertAccess).not.toHaveBeenCalled();
  });

  it.each(['toggle', 'send', 'remove'])(
    'denies %s on a restricted report',
    async (action) => {
      const call =
        action === 'toggle'
          ? controller.toggle(user, 'branch', 'sales', { isActive: true })
          : action === 'send'
            ? controller.sendNow(user, 'branch', 'sales')
            : controller.remove(user, 'branch', 'sales');
      await expect(call).rejects.toBeInstanceOf(ForbiddenException);
      expect(schedules.setActive).not.toHaveBeenCalled();
      expect(schedules.sendNow).not.toHaveBeenCalled();
      expect(schedules.remove).not.toHaveBeenCalled();
    },
  );

  it('preserves branch-scoped not-found semantics', async () => {
    schedules.get.mockRejectedValue(new NotFoundException());
    await expect(
      controller.sendNow(user, 'branch', 'other-branch-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(schedules.get).toHaveBeenCalledWith('branch', 'other-branch-id');
  });

  it('allows actions when the user holds the target permission', async () => {
    const authorized = {
      ...user,
      permissions: [...user.permissions, 'dashboard.sales.view'],
    };
    await controller.toggle(authorized, 'branch', 'sales', { isActive: true });
    await controller.sendNow(authorized, 'branch', 'sales');
    await controller.remove(authorized, 'branch', 'sales');
    expect(schedules.setActive).toHaveBeenCalledWith('branch', 'sales', true);
    expect(schedules.sendNow).toHaveBeenCalledWith('branch', 'sales');
    expect(schedules.remove).toHaveBeenCalledWith('branch', 'sales');
  });

  it('does not look up schedules when branch access fails', async () => {
    branch.assertAccess.mockRejectedValue(new ForbiddenException());
    await expect(
      controller.sendNow(user, 'branch', 'sales'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(schedules.get).not.toHaveBeenCalled();
  });
});

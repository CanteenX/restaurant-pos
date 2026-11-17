import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  createStaffSchema,
  departmentSchema,
  setPermissionOverridesSchema,
  updateStaffSchema,
  type SessionUser,
} from '@nventra/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { UsersService } from './users.service';
import { StaffInviteService } from './staff-invite.service';
import { Throttle } from '@nestjs/throttler';

@ApiTags('users')
@Controller('v1/users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly invites: StaffInviteService,
  ) {}

  @Auth('users.manage')
  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.usersService.list(user.restaurantId);
  }

  @Auth('users.manage')
  @Get('roles')
  listRoles(@CurrentUser() user: SessionUser) {
    return this.usersService.listRoles(user.restaurantId, user);
  }

  @Auth('users.manage')
  @Post()
  @UsePipes(new ZodValidationPipe(createStaffSchema))
  create(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.usersService.create(user.restaurantId, user, body as never);
  }

  @Auth('users.manage')
  @Patch(':id')
  @UsePipes(new ZodValidationPipe(updateStaffSchema))
  update(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    // The client address feeds the current-password rate limit (#236).
    return this.usersService.update(
      user.restaurantId,
      user,
      id,
      body as never,
      req.ip ?? 'unknown',
    );
  }

  @Auth('users.manage')
  @Delete(':id')
  remove(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.usersService.remove(user.restaurantId, user, id);
  }

  // --- Staff invites (#223) ------------------------------------------------
  // users.manage here, plus the #229 privilege ceiling in StaffInviteService.

  @Auth('users.manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/invite')
  sendInvite(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.invites.send(user.restaurantId, user, id);
  }

  @Auth('users.manage')
  @Delete(':id/invite')
  revokeInvite(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.invites.revoke(user.restaurantId, user, id);
  }

  // --- Departments ---------------------------------------------------------

  @Auth('users.manage')
  @Get('departments')
  listDepartments(@CurrentUser() user: SessionUser) {
    return this.usersService.listDepartments(user.restaurantId);
  }

  @Auth('users.manage')
  @Post('departments')
  @UsePipes(new ZodValidationPipe(departmentSchema))
  createDepartment(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.usersService.createDepartment(
      user.restaurantId,
      user.id,
      body as never,
    );
  }

  @Auth('users.manage')
  @Patch('departments/:id')
  @UsePipes(new ZodValidationPipe(departmentSchema))
  renameDepartment(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.usersService.renameDepartment(
      user.restaurantId,
      user.id,
      id,
      body as never,
    );
  }

  @Auth('users.manage')
  @Delete('departments/:id')
  removeDepartment(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.usersService.removeDepartment(user.restaurantId, user.id, id);
  }

  // --- Permission overrides ------------------------------------------------

  @Auth('users.manage', 'roles.manage')
  @Put(':id/permission-overrides')
  @UsePipes(new ZodValidationPipe(setPermissionOverridesSchema))
  setPermissionOverrides(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.usersService.setPermissionOverrides(
      user.restaurantId,
      user,
      id,
      body as never,
    );
  }
}

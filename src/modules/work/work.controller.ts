import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { RequireRole, Tenant } from '../../common/tenant/tenant.guard';
import { TenantContext, UserRole } from '../../common/tenant/tenant-context';
import { ActivityService } from './activity.service';
import { NotificationsService } from './notifications.service';
import { WorkProjectsService } from './projects.service';
import { TasksService } from './tasks.service';
import {
  CommentDto,
  CreateProjectDto,
  CreateTaskDto,
  MilestoneDto,
  UpdateMilestoneDto,
  UpdateProjectDto,
  UpdateTaskDto,
} from './work.dto';

const int = (v?: string) => (v !== undefined && v !== '' && Number.isInteger(Number(v)) ? Number(v) : undefined);

/** المشاريع والمهام: القراءة لأي عضو، والكتابة بحسب الدور. */
@Controller('work')
export class WorkController {
  constructor(
    private readonly projects: WorkProjectsService,
    private readonly tasks: TasksService,
  ) {}

  @Get('projects')
  listProjects(@Tenant() ctx: TenantContext, @Query('status') status?: string) {
    return this.projects.list(ctx, { status: int(status) });
  }

  @Get('projects/:id')
  getProject(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.get(ctx, id);
  }

  @RequireRole(UserRole.TeamLeader)
  @Post('projects')
  createProject(@Tenant() ctx: TenantContext, @Body() dto: CreateProjectDto) {
    return this.projects.create(ctx, dto);
  }

  @RequireRole(UserRole.TeamLeader)
  @Patch('projects/:id')
  updateProject(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projects.update(ctx, id, dto);
  }

  @RequireRole(UserRole.DeptManager)
  @Delete('projects/:id')
  removeProject(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.remove(ctx, id);
  }

  @RequireRole(UserRole.TeamLeader)
  @Post('projects/:id/milestones')
  addMilestone(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MilestoneDto,
  ) {
    return this.projects.addMilestone(ctx, id, dto);
  }

  @RequireRole(UserRole.TeamLeader)
  @Patch('milestones/:id')
  updateMilestone(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMilestoneDto,
  ) {
    return this.projects.updateMilestone(ctx, id, dto);
  }

  @RequireRole(UserRole.TeamLeader)
  @Delete('milestones/:id')
  removeMilestone(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.removeMilestone(ctx, id);
  }

  // ── المهام ──
  @Get('tasks')
  listTasks(
    @Tenant() ctx: TenantContext,
    @Query('projectId') projectId?: string,
    @Query('assignee') assignee?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    return this.tasks.list(ctx, { projectId, assignee, status: int(status), q: q?.trim() || undefined });
  }

  @Get('tasks/:id')
  getTask(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.get(ctx, id);
  }

  @RequireRole(UserRole.Employee)
  @Post('tasks')
  createTask(@Tenant() ctx: TenantContext, @Body() dto: CreateTaskDto) {
    return this.tasks.create(ctx, dto);
  }

  @RequireRole(UserRole.Employee)
  @Patch('tasks/:id')
  updateTask(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.tasks.update(ctx, id, dto);
  }

  @RequireRole(UserRole.TeamLeader)
  @Delete('tasks/:id')
  removeTask(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.remove(ctx, id);
  }

  @Get('tasks/:id/comments')
  comments(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.comments(ctx, id);
  }

  @RequireRole(UserRole.Employee)
  @Post('tasks/:id/comments')
  comment(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CommentDto,
  ) {
    return this.tasks.comment(ctx, id, dto);
  }
}

/** إشعاراتي — كل مستخدم يرى إشعاراته فقط. */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @Tenant() ctx: TenantContext,
    @Query('unread') unread?: string,
    @Query('page') page?: string,
  ) {
    return this.notifications.list(ctx, { unreadOnly: unread === '1', page: int(page) });
  }

  @Get('count')
  count(@Tenant() ctx: TenantContext) {
    return this.notifications.unreadCount(ctx);
  }

  @Post('read-all')
  readAll(@Tenant() ctx: TenantContext) {
    return this.notifications.markAllRead(ctx);
  }

  @Patch(':id/read')
  read(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(ctx, id);
  }

  @Delete(':id')
  remove(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.remove(ctx, id);
  }
}

/** سجل نشاط الشركة. */
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  list(
    @Tenant() ctx: TenantContext,
    @Query('page') page?: string,
    @Query('type') type?: string,
    @Query('actor') actor?: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.activity.list(ctx, {
      page: int(page),
      entityType: type || undefined,
      actorId: actor || undefined,
      projectId: projectId || undefined,
    });
  }
}

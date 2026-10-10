/** 0=على المسار · 1=في خطر · 2=متأخر · 3=مكتمل */
export enum ProjectStatus {
  OnTrack = 0,
  AtRisk = 1,
  Late = 2,
  Done = 3,
}

/** 0=متراكم · 1=للتنفيذ · 2=قيد التنفيذ · 3=قيد المراجعة · 4=مكتمل */
export enum TaskStatus {
  Backlog = 0,
  Todo = 1,
  InProgress = 2,
  Review = 3,
  Done = 4,
}

export const TASK_STATUS_LABEL = ['متراكم', 'للتنفيذ', 'قيد التنفيذ', 'قيد المراجعة', 'مكتمل'];

/** 0=منخفضة · 1=متوسطة · 2=عالية · 3=عاجلة */
export const MAX_PRIORITY = 3;

export type NotificationKind = 'assign' | 'comment' | 'mention' | 'milestone' | 'billing' | 'system';

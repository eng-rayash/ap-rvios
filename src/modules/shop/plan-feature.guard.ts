import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { TenantContext } from '../../common/tenant/tenant-context';
import { FeatureKey, hasFeature, minPlanFor, PLAN_FEATURES, planOf } from '../shop-billing/plans';
import { ShopStoreAccessService } from './shop-store-access.service';

export const PLAN_FEATURE_KEY = 'azm:planFeature';
/** يقصر المسار على متجر باقته فيها الميزة — يقرأ `:storeId` من المسار */
export const PlanFeature = (f: FeatureKey) => SetMetadata(PLAN_FEATURE_KEY, f);

/**
 * حارس مزايا الباقة — بعد حارس المستأجر. الرفض برمز `PLAN_FEATURE` ومعه الميزة
 * وأدنى باقة تفتحها، فتعرض اللوحة بطاقة «رقِّ باقتك» بدل خطأ عام.
 */
@Injectable()
export class PlanFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: ShopStoreAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(PLAN_FEATURE_KEY, [context.getHandler(), context.getClass()]);
    if (!feature) return true;
    const req = context.switchToHttp().getRequest<{ tenant?: TenantContext; params: Record<string, string> }>();
    const storeId = req.params?.storeId;
    if (!req.tenant || !storeId) return true;
    // المتجر من شركة الطالب أولًا: متجر غيره ٤٠٤ كما في المسار نفسه — ولا يُنشأ له اشتراك
    const { plan } = await this.access.require(req.tenant, storeId);
    if (hasFeature(plan, feature)) return true;
    const need = minPlanFor(feature);
    throw new ForbiddenException({
      message: `«${PLAN_FEATURES[feature].label}» ${need ? `متاحة من باقة ${planOf(need).name}` : 'غير متاحة في باقتك'} — رقِّ باقتك من «الباقة والاشتراك»`,
      code: 'PLAN_FEATURE',
      feature,
      plan: need,
    });
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ShopStore } from '@prisma/client';

import {
  TenantPrismaService,
  tenantCreate,
} from '../../../common/prisma/tenant-prisma.service';
import { TenantContext } from '../../../common/tenant/tenant-context';
import { StoreSubscriptionsService } from '../../shop-billing/store-subscriptions.service';
import { PLAN_BY_CODE } from '../../shop-billing/shop-billing.constants';
import { STORE_TEMPLATES, effectiveTemplate, isTemplate, templateCost } from '../store-templates';
import { domainProblem, normalizeDomain } from '../domain.util';
import { ShopStoreAccessService } from '../shop-store-access.service';
import { StoreImagesGc } from '../../uploads/store-images-gc.service';
import {
  COUNTRIES,
  DEFAULT_COUNTRY,
  LAYOUTS,
  PAY_METHODS,
  PLAN_NAME,
  SECTORS,
  SKINS,
  StoreStatus,
  symbolOf,
  toE164,
  validE164,
} from '../shop.constants';
import { slugProblem, slugify } from '../slug.util';
import { CreateStoreDto, UpdateStoreDto } from './stores.dto';

/** شكل المتجر كما تراه لوحة التاجر — العملة مشتقّة والسكِن فعّال لا محفوظ. */
export function storeView(store: ShopStore, plan: string) {
  const extra = plan === 'pro';
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    sector: store.sector,
    tagline: store.tagline,
    about: store.about,
    city: store.city,
    address: store.address,
    whatsapp: store.whatsapp,
    hours: store.hours,
    logo: store.logo,
    banner: store.banner,
    showcase: store.showcase,
    color: store.color,
    colorDeep: store.colorDeep,
    // لو هبط متجر من برو تبقى قيمته محفوظة لكن الواجهة تعود إلى «التوقيع»
    // (إخفاء لا حذف) فيسترجعها لحظة الترقية دون إعادة ضبط
    theme: extra && SKINS.has(store.theme) ? store.theme : 'signature',
    savedTheme: store.theme,
    layout: extra && LAYOUTS.has(store.layout) ? store.layout : 'signature',
    savedLayout: store.layout,
    // قالب منصة المتاجر الجديدة — الفعّال حسب الباقة، والمحفوظ يعود حين يعود حقّه
    template: effectiveTemplate(store.template, store.ownedTemplates, PLAN_BY_CODE[plan] ?? 0),
    savedTemplate: store.template,
    ownedTemplates: store.ownedTemplates,
    // النطاق الخاص للباقات المدفوعة — يُحفظ لو هبطت الباقة ويعود بعودتها
    customDomain: plan === 'basic' ? null : store.customDomain,
    savedCustomDomain: store.customDomain,
    plan,
    verified: store.verified,
    status: store.status,
    country: store.country,
    currency: symbolOf(store.country),
    deliveryFee: store.deliveryFee,
    deliveryFreeOver: store.deliveryFreeOver,
    deliveryNote: store.deliveryNote,
    payMethods: store.payMethods,
    payNote: store.payNote,
    createdAt: store.createdAt,
  };
}

@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly access: ShopStoreAccessService,
    private readonly subs: StoreSubscriptionsService,
    private readonly gc: StoreImagesGc,
  ) {}

  async list(ctx: TenantContext) {
    const db = this.prisma.forTenant(ctx.companyId);
    const [stores, slots] = await Promise.all([
      db.shopStore.findMany({ orderBy: { createdAt: 'asc' } }),
      this.subs.slotsOf(ctx.companyId),
    ]);
    const views = await Promise.all(
      stores.map(async (s) =>
        storeView(s, await this.access.planOf(ctx.companyId, s.id)),
      ),
    );
    return {
      stores: views,
      slots: {
        owned: stores.length,
        slots: slots.slots,
        free: Math.max(0, slots.slots - stores.length),
        max: slots.max,
      },
    };
  }

  async get(ctx: TenantContext, storeId: string) {
    const { store, plan } = await this.access.require(ctx, storeId);
    return { store: storeView(store, plan), plan };
  }

  /**
   * الرابط محجوز إن كان مستخدمًا الآن، **أو** كان رابطًا قديمًا لمتجر آخر:
   * إعطاؤه لتاجر جديد يحوّل زبائن المتجر الأول إليه — انتحال فعلي لا مجرد
   * تعارض أسماء. الفحص عبر العميل الأساس لأن التفرّد عالمي لا داخل شركة.
   */
  async slugTaken(slug: string, exceptStoreId?: string): Promise<boolean> {
    const live = await this.prisma.shopStore.findUnique({ where: { slug } });
    if (live && live.id !== exceptStoreId) return true;
    const retired = await this.prisma.shopSlugHistory.findUnique({
      where: { oldSlug: slug },
    });
    return !!retired && retired.storeId !== exceptStoreId;
  }

  /** فحص فوري لتوفر الرابط (§٣.٢). */
  async checkSlug(raw: string, exceptStoreId?: string) {
    const slug = slugify(raw);
    const problem = slugProblem(slug);
    if (problem) return { slug, ok: false, reason: problem, suggestion: null };
    if (await this.slugTaken(slug, exceptStoreId)) {
      return {
        slug,
        ok: false,
        reason: 'هذا الرابط محجوز',
        taken: true,
        suggestion: await this.suggestSlug(raw),
      };
    }
    return { slug, ok: true, reason: 'متاح', suggestion: null };
  }

  private async suggestSlug(raw: string): Promise<string> {
    let base = slugify(raw);
    if (!base || base.length < 3) base = 'mystore';
    if (!slugProblem(base) && !(await this.slugTaken(base))) return base;
    for (let i = 2; i < 200; i++) {
      const candidate = `${base}-${i}`.slice(0, 30).replace(/-$/, '');
      if (!slugProblem(candidate) && !(await this.slugTaken(candidate))) {
        return candidate;
      }
    }
    return `${base.slice(0, 24)}-${Date.now().toString(36).slice(-4)}`;
  }

  /** الدولة ثم الرقم: `790…` يكون أردنيًا لا يمنيًا بدولة المتجر. */
  private normalizeWhatsapp(input: string, country: string): string {
    const w = toE164(input, country);
    if (!validE164(w)) throw new BadRequestException('رقم واتساب غير صحيح');
    return w;
  }

  async create(ctx: TenantContext, dto: CreateStoreDto) {
    const db = this.prisma.forTenant(ctx.companyId);

    // الخانات: التاجر يبدأ بواحدة، والإضافية تُشترى (برو)
    const [owned, slots] = await Promise.all([
      db.shopStore.count(),
      this.subs.slotsOf(ctx.companyId),
    ]);
    if (owned >= slots.slots) {
      throw new ConflictException({
        message: 'بلغتَ عدد المتاجر المتاح في حسابك. اشترِ خانة متجر إضافي من قسم الاشتراك.',
        code: 'NO_STORE_SLOT',
      });
    }

    const country = (dto.country ?? DEFAULT_COUNTRY).toUpperCase();
    if (!COUNTRIES[country]) throw new BadRequestException('دولة غير مدعومة');

    const check = await this.checkSlug(dto.slug || dto.name);
    if (!check.ok) throw new BadRequestException(check.reason);

    const sector = dto.sector && SECTORS.has(dto.sector) ? dto.sector : 'other';
    const whatsapp = this.normalizeWhatsapp(dto.whatsapp, country);

    let store: ShopStore;
    try {
      store = await db.shopStore.create({
        data: tenantCreate<Prisma.ShopStoreUncheckedCreateInput>({
          slug: check.slug,
          name: dto.name.trim(),
          sector,
          tagline: dto.tagline?.trim() ?? '',
          city: dto.city?.trim() ?? '',
          whatsapp,
          country,
          ...(dto.color ? { color: dto.color } : {}),
          ...(dto.colorDeep ? { colorDeep: dto.colorDeep } : {}),
        }),
      });
    } catch (err) {
      // القيد الفريد حكم أخير عند سباق متزامن على الرابط نفسه
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('هذا الرابط حُجز للتوّ — جرّب رابطًا آخر');
      }
      throw err;
    }

    // اشتراك المتجر: الإضافي يرث باقة الحساب (دفع برو ثم خانة مخفّضة —
    // لو بدأ بالمجانية لاشترى خانة بلا قيمة). الأول مجاني.
    await this.subs.ensure(ctx.companyId, store.id, store.name);
    if (owned > 0) await this.inheritPlan(ctx.companyId, store.id);

    const plan = await this.access.planOf(ctx.companyId, store.id);
    return { store: storeView(store, plan) };
  }

  /** ينسخ أعلى باقة فعّالة بين متاجر الحساب إلى المتجر الجديد. */
  private async inheritPlan(companyId: string, storeId: string) {
    const db = this.prisma.forTenant(companyId);
    const others = await db.shopStore.findMany({
      where: { id: { not: storeId } },
      select: { id: true },
    });
    let best: { id: string; rank: number } | null = null;
    for (const o of others) {
      const plan = await this.access.planOf(companyId, o.id);
      const rank = plan === 'pro' ? 2 : plan === 'plus' ? 1 : 0;
      if (rank > 0 && (!best || rank > best.rank)) best = { id: o.id, rank };
    }
    if (best) await this.subs.inherit(companyId, storeId, best.id);
  }

  async update(ctx: TenantContext, storeId: string, dto: UpdateStoreDto) {
    const { store, plan, limits } = await this.access.require(ctx, storeId, {
      writable: true,
    });
    const data: Prisma.ShopStoreUncheckedUpdateInput = {};

    if (dto.name !== undefined) data.name = dto.name.trim() || store.name;
    for (const k of ['tagline', 'about', 'city', 'address', 'hours', 'logo', 'banner', 'showcase'] as const) {
      if (dto[k] !== undefined) data[k] = dto[k]!.trim();
    }
    // قطاع لا نعرفه يُتجاهل بدل حفظه: القيمة تُعرض فوق واجهة المتجر
    if (dto.sector !== undefined && SECTORS.has(dto.sector)) data.sector = dto.sector;
    if (dto.color) data.color = dto.color;
    if (dto.colorDeep) data.colorDeep = dto.colorDeep;

    // السكِنات والقوالب الإضافية ميزة برو — الرفض صريح: تاجر يظن أن اختياره
    // سرى ثم لا يراه أسوأ من منع
    if (dto.theme !== undefined) {
      if (!SKINS.has(dto.theme)) throw new BadRequestException('سكِن غير معروف');
      if (dto.theme !== 'signature' && !limits.extraThemes) {
        throw new ConflictException({
          message: `السكِنات الإضافية متاحة في باقة ${PLAN_NAME.pro}`,
          code: 'PLAN_LIMIT',
        });
      }
      data.theme = dto.theme;
    }
    if (dto.template !== undefined) {
      // القالب يُختار إن كان مجانيًا للباقة أو مملوكًا؛ المدفوع يُشترى بفاتورة قالب
      if (!isTemplate(dto.template)) throw new BadRequestException('قالب غير معروف');
      const cost = templateCost(dto.template, PLAN_BY_CODE[plan] ?? 0, STORE_TEMPLATES[dto.template].price);
      if (cost === null) {
        throw new ConflictException({ message: 'القوالب المدفوعة تحتاج باقة مدفوعة — رقِّ باقتك أولاً', code: 'PLAN_REQUIRED' });
      }
      if (cost > 0 && !store.ownedTemplates.includes(dto.template)) {
        throw new ConflictException({ message: 'هذا القالب يُشترى أولاً — اطلبه من صفحة الاشتراك', code: 'TEMPLATE_NOT_OWNED' });
      }
      data.template = dto.template;
    }
    if (dto.customDomain !== undefined) {
      const domain = normalizeDomain(dto.customDomain);
      if (!domain) {
        data.customDomain = null;
      } else {
        if (plan === 'basic') {
          throw new ConflictException({ message: 'النطاق الخاص للباقات المدفوعة — رقِّ باقتك أولاً', code: 'PLAN_REQUIRED' });
        }
        const problem = domainProblem(domain);
        if (problem) throw new BadRequestException(problem);
        const taken = await this.prisma.shopStore.findFirst({ where: { customDomain: domain, id: { not: store.id } }, select: { id: true } });
        if (taken) throw new ConflictException('هذا النطاق مربوط بمتجر آخر');
        data.customDomain = domain;
      }
    }
    if (dto.layout !== undefined) {
      if (!LAYOUTS.has(dto.layout)) throw new BadRequestException('قالب غير معروف');
      if (dto.layout !== 'signature' && !limits.extraThemes) {
        throw new ConflictException({
          message: `القوالب الإضافية متاحة في باقة ${PLAN_NAME.pro}`,
          code: 'PLAN_LIMIT',
        });
      }
      data.layout = dto.layout;
    }

    if (dto.deliveryFee !== undefined) data.deliveryFee = dto.deliveryFee;
    if (dto.deliveryFreeOver !== undefined) data.deliveryFreeOver = dto.deliveryFreeOver;
    if (dto.deliveryNote !== undefined) data.deliveryNote = dto.deliveryNote.trim();
    if (dto.payNote !== undefined) data.payNote = dto.payNote.trim();
    if (dto.payMethods !== undefined) {
      const picked = dto.payMethods.filter((m) => m in PAY_METHODS);
      // «عند الاستلام» لا يُنزع: متجر بلا طريقة دفع واحدة لا يستقبل طلبًا
      data.payMethods = (picked.length ? picked : ['cod']).join(',');
    }

    // الدولة تُقرأ قبل الرقم: من يغيّر دولته في الطلب نفسه يُفهَم رقمه بها
    let country = store.country;
    if (dto.country !== undefined) {
      country = dto.country.toUpperCase();
      if (!COUNTRIES[country]) throw new BadRequestException('دولة غير مدعومة');
      data.country = country;
    }
    if (dto.whatsapp !== undefined) {
      data.whatsapp = this.normalizeWhatsapp(dto.whatsapp, country);
    }

    let newSlug: string | null = null;
    if (dto.slug !== undefined && dto.slug !== store.slug) {
      const check = await this.checkSlug(dto.slug, store.id);
      if (!check.ok) throw new BadRequestException(check.reason);
      newSlug = check.slug;
      data.slug = newSlug;
    }

    if (!Object.keys(data).length) {
      return { store: storeView(store, plan) };
    }

    // الرابط القديم يُحفظ قبل تغييره ليبقى يعمل بتحويل دائم (§٣.٣)
    const updated = await this.prisma.$transaction(async (tx) => {
      if (newSlug) {
        await tx.shopSlugHistory.upsert({
          where: { oldSlug: store.slug },
          create: { oldSlug: store.slug, storeId: store.id, companyId: ctx.companyId },
          update: { storeId: store.id, changedAt: new Date() },
        });
        // لو كان الرابط الجديد مستخدمًا سابقًا لهذا المتجر نحرّره من السجل
        await tx.shopSlugHistory.deleteMany({ where: { oldSlug: newSlug } });
      }
      return tx.shopStore.update({ where: { id: store.id }, data });
    });
    // شعار أو غلاف استُبدل — يُحذف القديم من التخزين لاحقًا
    if (dto.logo !== undefined || dto.banner !== undefined || dto.showcase !== undefined) this.gc.schedule(store.id);
    return { store: storeView(updated, plan) };
  }

  /** حذف متجر واحد — لا المتجر الوحيد (احذف الحساب بدلًا من ذلك). */
  async remove(ctx: TenantContext, storeId: string) {
    const { store } = await this.access.require(ctx, storeId);
    const db = this.prisma.forTenant(ctx.companyId);
    if ((await db.shopStore.count()) <= 1) {
      throw new ConflictException({
        message: 'لا يمكن حذف متجرك الوحيد بهذا المسار',
        code: 'LAST_STORE',
      });
    }
    await db.shopStore.delete({ where: { id: store.id } });
    // الاشتراك لا يبقى يتيمًا في عدّ الخانات ولا في لوحة الإدارة
    await this.subs.remove(ctx.companyId, store.id);
    // صور المتجر تُحذف من التخزين معه — عدا الإيصالات (سجلّ مالي)
    this.gc.purge(store.id);
    return { ok: true };
  }

  // ── فريق المنصة: عبر كل الشركات ────────────────────────
  async platformList(q?: string) {
    const rows = await this.prisma.shopStore.findMany({
      where: q
        ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q, mode: 'insensitive' } }] }
        : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        organization: { select: { id: true, name: true, companyCode: true } },
        _count: { select: { products: true, orders: true } },
      },
    });
    return rows;
  }

  async platformSetStatus(storeId: string, suspended: boolean) {
    const store = await this.prisma.shopStore.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException('المتجر غير موجود');
    return this.prisma.shopStore.update({
      where: { id: storeId },
      data: { status: suspended ? StoreStatus.Suspended : StoreStatus.Active },
    });
  }

  async platformSetVerified(storeId: string, verified: boolean) {
    const store = await this.prisma.shopStore.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException('المتجر غير موجود');
    return this.prisma.shopStore.update({ where: { id: storeId }, data: { verified } });
  }
}

import { IsString, MaxLength } from 'class-validator';

export class GoogleLoginDto {
  /** رمز الهوية (JWT) من Google Identity Services — يُتحقق منه في الخادم */
  @IsString()
  @MaxLength(4096)
  credential!: string;
}

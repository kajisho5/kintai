import nodemailer from "nodemailer";
import { BRAND } from "../brand";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** 開発用: 送らずに標準出力へ出す（リンクを確認できる） */
export class ConsoleMailer implements Mailer {
  async send(m: Mail): Promise<void> {
    console.log(`\n--- メール（開発用・送信なし） ---\nTo: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n---`);
  }
}

export class SmtpMailer implements Mailer {
  private transport;
  constructor(url: string, private readonly from: string) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(m: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text });
  }
}

/** テスト用: 送信内容をためる */
export class MemoryMailer implements Mailer {
  sent: Mail[] = [];
  async send(m: Mail): Promise<void> {
    this.sent.push(m);
  }
}

/** SMTP_URL（例: smtps://user:pass@smtp.example.com）があれば実際に送る。なければ開発用の出力のみ */
export function mailerFromEnv(env: NodeJS.ProcessEnv): Mailer {
  if (env.SMTP_URL) return new SmtpMailer(env.SMTP_URL, env.MAIL_FROM ?? `${BRAND.name} <${BRAND.operator.email}>`);
  if (env.NODE_ENV === "production") console.warn("警告: SMTP_URL が未設定のため、メールは送信されません（パスワード再設定などが使えません）");
  return new ConsoleMailer();
}

const sign = `\n--\n${BRAND.name}（${BRAND.tagline}）\n${BRAND.operator.name}\nお問い合わせ: ${BRAND.operator.email}\n`;

export const templates = {
  welcome(p: { adminName: string; companyName: string; code: string; loginUrl: string; trialDays: number }): Pick<Mail, "subject" | "text"> {
    return {
      subject: `【${BRAND.name}】ご登録ありがとうございます`,
      text: `${p.adminName} 様

${BRAND.name} にご登録いただきありがとうございます。${p.companyName}の無料トライアル（${p.trialDays}日間）を開始しました。

ログイン情報
  企業ID: ${p.code}
  ログインURL: ${p.loginUrl}

次の手順
  1. 「社員管理」から社員を追加します（CSVでまとめて取り込めます）
  2. 「会社設定」で、特別条項の有無や会社の休日を確認します
  3. 社員に一時パスワードを伝え、打刻を始めます
${sign}`,
    };
  },

  passwordReset(p: { link: string; minutes: number }): Pick<Mail, "subject" | "text"> {
    return {
      subject: `【${BRAND.name}】パスワード再設定のご案内`,
      text: `パスワードの再設定を受け付けました。次のリンクから、新しいパスワードを設定してください（${p.minutes}分間有効・1回のみ）。

${p.link}

このメールに心当たりがない場合は、何もせずに破棄してください。パスワードは変更されません。
${sign}`,
    };
  },

  trialEnding(p: { adminName: string; daysLeft: number; billingUrl: string }): Pick<Mail, "subject" | "text"> {
    return {
      subject: `【${BRAND.name}】無料トライアルはあと${p.daysLeft}日で終了します`,
      text: `${p.adminName} 様

無料トライアルの終了まで、あと${p.daysLeft}日です。終了後は閲覧のみとなり、打刻や申請ができなくなります（データは削除されません）。

引き続きご利用いただく場合は、次のページからお申し込みください。
${p.billingUrl}
${sign}`,
    };
  },
};

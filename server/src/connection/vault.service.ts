import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// 凭据保险库：用 AES-256-GCM 加密敏感字段（密码）。
// 主密钥优先级：环境变量 DBADMIN_MASTER_KEY（64 位 hex） > 本地密钥文件（首次启动生成）。
// 桌面模式可改为从系统钥匙串读取主密钥。绝不把明文密码写入连接配置文件。

const KEY_FILE = path.join(process.cwd(), '.vault-key');
const ALGO = 'aes-256-gcm';

@Injectable()
export class VaultService {
  private key: Buffer;

  constructor() {
    this.key = this.loadKey();
  }

  private loadKey(): Buffer {
    const fromEnv = process.env.DBADMIN_MASTER_KEY;
    if (fromEnv && /^[0-9a-fA-F]{64}$/.test(fromEnv)) {
      return Buffer.from(fromEnv, 'hex');
    }
    if (fs.existsSync(KEY_FILE)) {
      return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    }
    const k = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, k.toString('hex'), { mode: 0o600 });
    return k;
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

  decrypt(payload: string): string {
    const [ivHex, tagHex, dataHex] = payload.split(':');
    const decipher = crypto.createDecipheriv(ALGO, this.key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
  }
}

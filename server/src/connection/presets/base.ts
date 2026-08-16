// 通用连接字段构造：host / port / user / password / database
import { ConnectField } from '../dialects/types';

export const commonFields = (
  portDefault: number,
  dbLabel = '数据库',
): ConnectField[] => [
  { key: 'host', label: '主机', type: 'text', default: '127.0.0.1', required: true },
  { key: 'port', label: '端口', type: 'number', default: portDefault, required: true },
  { key: 'user', label: '用户名', type: 'text', required: true },
  { key: 'password', label: '密码', type: 'password' },
  { key: 'database', label: dbLabel, type: 'text' },
];

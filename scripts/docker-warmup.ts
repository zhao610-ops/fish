import { Database } from "@db/sqlite";

// 只访问内存数据库；让构建阶段预加载对应架构的 SQLite FFI 库。
const database = new Database(":memory:");
try {
  database.prepare("SELECT 1").get();
} finally {
  database.close();
}

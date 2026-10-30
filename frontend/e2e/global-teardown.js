import { connectDatabase, disconnectDatabase, mongoose } from "../../backend/src/models/db.js";
import { isolatedDatabaseName } from "./global-setup.js";

export default async function globalTeardown() {
  const uri = process.env.MONGODB_URI || "";
  isolatedDatabaseName(uri);
  await connectDatabase(uri);
  try {
    await mongoose.connection.dropDatabase();
  } finally {
    await disconnectDatabase();
  }
}

import { z } from "zod";

export type UserRole = "admin" | "user";

export const UserSchema = z.object({
  id: z.string(),
  staffId: z.string(),
  name: z.string(),
  role: z.enum(["admin", "user"]),
  homeDir: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;

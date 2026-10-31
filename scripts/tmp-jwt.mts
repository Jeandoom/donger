import { SignJWT } from "jose";
const secret = (await import("node:fs")).readFileSync("/tmp/jwt_secret.txt", "utf8").trim();
const jti = "hotdeploy-smoke-" + Date.now();
const token = await new SignJWT({ sub: "ea93a449-b49b-4a9c-a226-27f1cf0d3ff3" })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setJti(jti)
  .setExpirationTime("10m")
  .sign(new TextEncoder().encode(secret));
console.log(token);
console.error("JTI=" + jti);

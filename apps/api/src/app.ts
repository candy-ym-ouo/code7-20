import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { config } from "./config";
import { AppError } from "./errors";
import { query } from "./db";
import { authRoutes } from "./routes/auth";
import { featureRoutes } from "./routes/features";
import { mediaRoutes } from "./routes/media";
import { commentRoutes } from "./routes/comments";
import { reportRoutes } from "./routes/reports";
import { moderationRoutes } from "./routes/moderation";
import { searchRoutes } from "./routes/search";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"]
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.APP_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "Idempotency-Key"]
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute"
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy", "geolocation=(self)");
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  await app.register(async (api) => {
    // Fastify 的 setErrorHandler 是作用域隔离的：必须在封装了这些路由的
    // 同一插件上下文里设置，根实例上的 handler 不会作用于 /api/v1 子作用域。
    api.setErrorHandler((error, request, reply) => {
      // 用结构/名称判断而非 instanceof：workspace 包各自依赖 zod 时，
      // ESM/CJS 双份副本会让 instanceof 误判。
      const isZodError =
        error instanceof ZodError ||
        (typeof error === "object" && error !== null &&
          (error as { name?: unknown }).name === "ZodError" &&
          Array.isArray((error as { issues?: unknown }).issues));
      if (isZodError) {
        return reply.code(400).send({
          type: "about:blank",
          title: "Validation failed",
          status: 400,
          code: "VALIDATION_FAILED",
          detail: "Request did not match the required schema",
          issues: (error as ZodError).issues,
          requestId: request.id
        });
      }
      if (error instanceof AppError) {
        return reply.code(error.statusCode).send({
          type: "about:blank",
          title: error.code,
          status: error.statusCode,
          code: error.code,
          detail: error.message,
          details: error.details,
          requestId: request.id
        });
      }
      request.log.error({ err: error }, "unhandled request error");
      return reply.code(500).send({
        type: "about:blank",
        title: "INTERNAL_ERROR",
        status: 500,
        code: "INTERNAL_ERROR",
        detail: "An unexpected error occurred",
        requestId: request.id
      });
    });

    api.setNotFoundHandler((request, reply) => reply.code(404).send({
      type: "about:blank",
      title: "NOT_FOUND",
      status: 404,
      code: "NOT_FOUND",
      detail: "Route not found",
      requestId: request.id
    }));

    api.register(authRoutes);
    api.register(featureRoutes);
    api.register(mediaRoutes);
    api.register(commentRoutes);
    api.register(reportRoutes);
    api.register(moderationRoutes);
    api.register(searchRoutes);
  }, { prefix: "/api/v1" });

  return app;
}

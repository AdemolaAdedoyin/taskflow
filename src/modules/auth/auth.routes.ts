import { Router } from "express";
import { AuthPrincipal } from "../../middleware/auth";

export const authRouter = Router();

authRouter.get("/whoami", (_req, res) => {
  const principal = res.locals.auth as AuthPrincipal;
  res.json({
    clientId: principal.clientId,
    scopes: principal.scopes,
  });
});

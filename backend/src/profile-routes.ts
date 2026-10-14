import { Router } from "express";
import { validateProfileInput } from "./profile-validation.js";
import { getProfile, saveProfile, type StoredProfile } from "./profile-store.js";

// HTTP layer for the candidate profile. Mounted at /profile; the browser
// reaches it as /api/profile through the Vite dev-server proxy.
//
// Database errors are not handled here: Express 5 forwards rejected promises
// to the error handler in app.ts, which maps them to safe 503/500 responses.
export const profileRouter = Router();

function toJson(profile: StoredProfile) {
  return { ...profile, updatedAt: profile.updatedAt.toISOString() };
}

profileRouter.get("/", async (_req, res) => {
  const profile = await getProfile();
  res.status(200).json(profile ? toJson(profile) : null);
});

profileRouter.put("/", async (req, res) => {
  const result = validateProfileInput(req.body);
  if (!result.ok) {
    res.status(400).json({
      error: "validation_error",
      message: "The profile is invalid.",
      details: result.errors,
    });
    return;
  }
  const saved = await saveProfile(result.value);
  res.status(200).json(toJson(saved));
});

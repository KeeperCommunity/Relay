import express from "express";
import { AddressInfo } from "net";
import { localDevelopmentRoutes } from "../../localDevelopment";

it("allows disposable backup routes while hosted integrations remain unavailable", async () => {
  const app = express();
  app.use(express.json(), localDevelopmentRoutes);
  app.post("/getBackupSnapshot", (_req, res) => res.json({ revision: "synthetic-revision" }));
  app.post("/repairAppBackup", (_req, res) => res.json({ updated: true }));
  app.post("/offer", (_req, res) => res.json({ shouldNotReachProvider: true }));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const route of ["getBackupSnapshot", "repairAppBackup"]) {
      const response = await fetch(`${baseUrl}/${route}`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
      expect(response.status).toBe(200);
    }
    const response = await fetch(`${baseUrl}/offer`, { method: "POST" });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("LOCAL_INTEGRATION_UNAVAILABLE");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

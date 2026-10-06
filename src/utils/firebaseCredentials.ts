import admin from "firebase-admin";

export function firebaseCredential(): admin.credential.Credential {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw === undefined) {
    // Managed identity or a credential file mounted outside the repository.
    return admin.credential.applicationDefault();
  }
  try {
    const account = JSON.parse(raw);
    if (account.type !== "service_account" ||
        typeof account.project_id !== "string" || !account.project_id.trim() ||
        typeof account.client_email !== "string" || !account.client_email.trim() ||
        typeof account.private_key !== "string" || !account.private_key.trim()) {
      throw new Error("Invalid service account shape");
    }
    return admin.credential.cert({
      projectId: account.project_id,
      clientEmail: account.client_email,
      privateKey: account.private_key.replace(/\\n/g, "\n"),
    });
  } catch (_) {
    throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_JSON configuration");
  }
}

// The VM identity belongs to bhrelay, while Keeper notifications belong to
// keeper-7b45f. Never infer the FCM target from the VM's host project.
export function firebaseAppOptions(): admin.AppOptions | undefined {
  if (process.env.LOCAL_DEV === "true") {
    return undefined;
  }
  const explicitProject = process.env.FIREBASE_PROJECT_ID?.trim();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  let projectId = explicitProject;
  if (!projectId && raw !== undefined) {
    try {
      projectId = JSON.parse(raw).project_id;
    } catch (_) {
      throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_JSON configuration");
    }
  }
  if (!projectId) {
    if (raw !== undefined) {
      firebaseCredential(); // Fail on a malformed explicit account.
    }
    return undefined; // Notifications are an optional local integration.
  }
  return { credential: firebaseCredential(), projectId };
}

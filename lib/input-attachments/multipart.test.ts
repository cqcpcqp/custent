import { describe, expect, it } from "vitest";

import { parseSingleInputAttachment } from "./multipart";

function multipartRequest(formData: FormData): Request {
  return new Request("http://localhost/api/input-attachments", {
    method: "POST",
    body: formData,
  });
}

describe("streaming input attachment multipart parser", () => {
  it("accepts exactly one named file part", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new File(["buyers"], "buyers.txt", { type: "text/plain" }),
    );

    const file = await parseSingleInputAttachment(
      multipartRequest(formData),
      10,
    );

    expect(file.name).toBe("buyers.txt");
    expect(file.type).toBe("text/plain");
    await expect(file.text()).resolves.toBe("buyers");
  });

  it("rejects fields, extra files, and an incorrect part name", async () => {
    const withField = new FormData();
    withField.append(
      "file",
      new File(["buyers"], "buyers.txt", { type: "text/plain" }),
    );
    withField.append("description", "not allowed");
    await expect(
      parseSingleInputAttachment(multipartRequest(withField), 100),
    ).rejects.toMatchObject({ status: 400 });

    const withTwoFiles = new FormData();
    withTwoFiles.append(
      "file",
      new File(["first"], "first.txt", { type: "text/plain" }),
    );
    withTwoFiles.append(
      "file",
      new File(["second"], "second.txt", { type: "text/plain" }),
    );
    await expect(
      parseSingleInputAttachment(multipartRequest(withTwoFiles), 100),
    ).rejects.toMatchObject({ status: 400 });

    const wrongName = new FormData();
    wrongName.append(
      "attachment",
      new File(["buyers"], "buyers.txt", { type: "text/plain" }),
    );
    await expect(
      parseSingleInputAttachment(multipartRequest(wrongName), 100),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("hard-truncates an oversized file while reading the multipart stream", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new File(["123456"], "buyers.txt", { type: "text/plain" }),
    );

    await expect(
      parseSingleInputAttachment(multipartRequest(formData), 5),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("rejects a malformed non-multipart body", async () => {
    await expect(
      parseSingleInputAttachment(
        new Request("http://localhost/api/input-attachments", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: "buyers",
        }),
        10,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

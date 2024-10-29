const express = require("express");
const app = express();
const { Server } = require("socket.io");
const fs = require("fs");
const cors = require("cors");
const dotenv = require("dotenv");
const { Readable } = require("stream");
const axios = require("axios");
const OpenAI = require("openai");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
dotenv.config();
const openai = new OpenAI({
  apiKey: process.env.OPEN_AI_KEY,
});
app.use(cors());
const http = require("http");
const server = http.createServer(app);

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_KEY,
  },
  region: process.env.BUCKET_REGION,
});
const io = new Server(server, {
  cors: {
    origin: process.env.ELECTRON_HOST,
    methods: ["GET", "POST"],
  },
});
let recordedChunks = [];
io.on("connection", (socket) => {
  console.log(`🟢 User connected`);
  socket.on("video-chunks", async (data) => {
    console.log(`🟢 Video chunks received`);
    const writeStream = fs.createWriteStream("temp_upload/" + data.filename);
    recordedChunks.push(data.chunks);
    const videoBlob = new Blob(recordedChunks, {
      type: "video/webm; codecs=vp9",
    });
    const buffer = Buffer.from(await videoBlob.arrayBuffer());
    const readableStream = Readable.from(buffer);
    readableStream.pipe(writeStream).on("finish", () => {
      console.log(`🟢 Video saved to temp_upload`);
    });
  });
  socket.on("process-video", async (data) => {
    console.log(`🟢 Video processing requested`);
    recordedChunks = [];
    fs.readFile("temp_upload/" + data.fileName, async (err, file) => {
      const processing = await axios.post(
        `${process.env.NEXT_API_HOST}recording/${data.userId}/processing`,
        { filename: data.filename }
      );
      if (processing.data.status !== 200)
        return console.log(`Error occurred while processing video`);
      const Key = data.filename;
      const Bucket = process.env.BUCKET_NAME;
      const ContentType = "video/webm";
      const command = new PutObjectCommand({
        Key,
        Bucket,
        ContentType,
        Body: file,
      });
      const fileStatus = await s3.send(command);
      if (fileStatus["$metadata"].httpStatusCode === 200) {
        console.log(`🟢 Video uploaded to S3`);
        if (processing.data.plan === "PRO") {
          fs.stat("temp_upload/" + data.filename, async (err, stat) => {
            if (!err) {
              if (stat.size < 25000000) {
                const transcription = await openai.audio.transcriptions.create({
                  file: fs.createReadStream(`temp_upload/${data.filename}`),
                  model: "whisper-1",
                  response_format: "text",
                });
                if (transcription) {
                  const completion = await openai.chat.completions.create({
                    model: "gpt-3.5-turbo",
                    response_format: { type: "json_object" },
                    messages: [
                      {
                        role: "system",
                        content: `You are a going to generate title and a nice description using the speech
                          to text transcription provided: transcription(${transcription}) and then return
                          it in  json format as {"title": <the title you gave>, "summary": <the summary you created>}`,
                      },
                    ],
                  });
                  const titleAndSummaryGenerated = await axios.post(
                    `${process.env.NEXT_API_HOST}recording/${data.userId}/transcribe`,
                    {
                      filename: data.filename,
                      content: completion.choices[0].message.content,
                      transcript: transcription,
                    }
                  );
                  if (titleAndSummaryGenerated.data.status !== 200)
                    return console.log(
                      `Error occurred while generating title and summary`
                    );
                }
              }
            }
          });
        }
        const stopProcessing = await axios.post(
          `${process.env.NEXT_API_HOST}recording/${data.userId}/complete`,
          { filename: data.filename }
        );
        if (stopProcessing.data.status !== 200)
          console.log(`Error occurred while stopping video processing`);

        if (stopProcessing.status === 200) {
          fs.unlink(`temp_upload/` + data.filename, (err) => {
            if (!err)
              console.log(
                data.filename + " " + `🟢 Video deleted from temp_upload`
              );
          });
        }
      } else {
        console.log(`Error occurred while deleting video from temp_upload`);
      }
    });
  });
  socket.on("disconnect", () => {
    console.log(`🟢 User disconnected`, socket.id);
  });
});

server.listen(5000, () => {
  console.log("🟢 Opal Express is running on port 5000");
});

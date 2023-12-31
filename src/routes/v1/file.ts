import express from 'express';
import Reply from "../../classes/Reply/Reply.js";
import Database from "../../db.js";
import NotFoundReply from "../../classes/Reply/NotFoundReply.js";
import {fileTypeStream} from "file-type";
import {contentType} from "mime-types";
import multer from "multer";
import fs from "fs";
import * as crypto from "crypto";
import BadRequestReply from "../../classes/Reply/BadRequestReply.js";
import Auth, {AuthPermitPermanent} from "../../middleware/Auth.js";
import ForbiddenReply from "../../classes/Reply/ForbiddenReply.js";
import ServerErrorReply from "../../classes/Reply/ServerErrorReply.js";
import mongoose from "mongoose";
const router = express.Router();

const database = new Database();

const tmpStorage = multer.diskStorage({
    filename: function (req, file, cb) {
        cb(null, crypto.randomBytes(8).toString("base64url"))
    }
})
const upload = multer({storage: tmpStorage})

const getEndpoint = async (req, res) => {
    const download = !!req.query?.download
    req.params.fileId = req.params.fileId.split(".")[0];
    // Read file metadata from file bucket with official driver
    let fileCursor = database.FileBucket.find({"metadata.shortId": req.params.fileId})
    let file
    for await (const doc of fileCursor) {
        file = doc
    }
    if (!file) return res.reply(new NotFoundReply())

    const returnFile = async () => {
        // Create a stream from GridFS with official driver and pipe it to response
        let fileStream = database.FileBucket.openDownloadStream(file._id)
        // Get file type from stream, fallback to filename based, and then octet stream
        fileStream = await fileTypeStream(fileStream);
        let mimeType = fileStream?.fileType?.mime;
        if (!mimeType) {
            // Couldn't detect a mime type, probably a text file not binary
            // Check with mime-types
            mimeType = contentType(file.filename)
        }
        // If mime type still was not detected fall back to octet stream
        res.header("Content-Type", mimeType || "application/octet-stream")
        // If download query is set return as attachment, by default show inline
        res.header("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${file.filename}"`)

        //console.log(typeIdStream.length)
        fileStream.pipe(res);
    }

    if (!file.metadata.private) return returnFile()
    await AuthPermitPermanent(req, res, () => {
        if (res.locals.dToken.user.equals(file.metadata.uploadedBy)) return returnFile();
        res.reply(new ForbiddenReply())
    })
}


const uploadEndpoint = (isOld = false) => {
    return async (req, res) => {
        // TODO: Aliases
        if (!req.files || !Array.isArray(req.files) || req.files.length < 1) return res.reply(new BadRequestReply("Upload at least one file in multipart/form-data request"))
        if (req.files.length > 10) return res.reply(new BadRequestReply("Upload a maximum of 10 files at a time."))
        /**
         * Upload files to GridFS
         */
        let uploadPromises : Promise<string>[] = req.files.map(file => new Promise(resolve => {
            let readStream = fs.createReadStream(file.path);
            let shortId = crypto.randomBytes(4).toString("base64url"); // (2^8)^4 = 4294967296
            let uploadStream = database.FileBucket.openUploadStream(file.originalname, {
                _id: new mongoose.Types.ObjectId(),
                metadata: {
                    shortId, // Randomly generated ID to use for URL, because ObjectID is very long
                    uploadedBy: res.locals.dToken.user, // Reference back to user ID
                    private: !!req.headers["w-private"], // If w-private header is present make files private
                    persistent: !!res.locals.dToken?.persistAll, // Used by system accounts like Lightquark to prevent automatic deletion of files
                    tags: [...(res.locals.dToken?.defaultTags || []), ...(req.headers?.["w-tags"]?.split(";")?.filter(t => t.trim().length > 0) || [ "api upload" ])]
                    // First default tags from token, then headers (default "api upload")
                }
            });
            readStream.pipe(uploadStream);
            uploadStream.on('finish', () => {
                let fileNameParts = file.originalname.split(".")
                resolve({id: shortId, extension: fileNameParts[fileNameParts.length - 1]});
            });
        }))

        /**
         * Response
         */
        let aliasesToUse : string[];
        let protocol = "https://"
        switch (process.env.WC_ENV) {
            case "local":
                aliasesToUse = ["localhost:45303"]
                // noinspection HttpUrlsUsage <-- reason should be obvious
                protocol = "http://"
                break;
            case "dev":
                aliasesToUse = ["phoenix.wanderers.cloud"]
                break;
            default:
                aliasesToUse = ["wanderers.cloud"]
                break;
        }

        if (req.headers["w-domains"] && req.headers["w-domains"].length > 0) aliasesToUse = req.headers["w-domains"].split(";");
        let alias : string = aliasesToUse[Math.floor(Math.random() * aliasesToUse.length)]
        let urlBase : string = `${protocol}${alias}${isOld ? "/file/" : "/v1/file/"}`
        let uploads : any[] = await Promise.all(uploadPromises);

        // Old endpoint needs to return in a stupid format
        if (!isOld) {
            res.reply(new Reply({
                response: {
                    message: "Upload complete",
                    uploadedFiles: uploads.map(u => `${urlBase}${u.id}`)
                }
            }))
        } else {
            if (uploads.length === 1) {
                return res.send(`${urlBase}${uploads[0].id}.${uploads[0].extension}`)
            } else {
                return res.send(uploads.map(u => `${urlBase}${u.id}.${u.extension}`))
            }
        }
    }

}
// Backwards compatibility endpoints
router.post("/upload", AuthPermitPermanent, upload.any(), uploadEndpoint(true));
router.get("/file/:fileId", getEndpoint);

// New endpoints
router.put("/v1/file", AuthPermitPermanent, upload.any(), uploadEndpoint());
router.get("/v1/file/:fileId", getEndpoint);

// Allow permanent tokens for backwards compatibility
router.delete("/v1/file/:fileId", AuthPermitPermanent, async (req, res) => {
    try {
        let fileCursor = database.FileBucket.find({"metadata.shortId": req.params.fileId, "metadata.uploadedBy": res.locals.dToken.user})
        let file : any;
        for await (const doc of fileCursor) {
            file = doc
        }
        if (!file) return res.reply(new NotFoundReply());

        await database.FileBucket.delete(file._id)
        return res.reply(new Reply({response: {
                message: "File deleted"
            }
        }));
    } catch (e) {
        console.error(e);
        res.reply(new ServerErrorReply())
    }
})

router.get("/v1/file", Auth, async (req, res) => {
    let cursor = database.FileBucket.find({"metadata.uploadedBy": res.locals.dToken.user})

    // I am sure there is a better way to do this, however I am not used to the native driver.
    let files : any[] = []
    for await (const file of cursor) {
        files.push(file);
    }

    return res.reply(new Reply({
        response: {
            message: "Files listed",
            files
        }
    }))
})

export default router;
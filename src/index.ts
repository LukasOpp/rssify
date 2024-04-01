import express, { Request, Response, NextFunction, Express } from "express";
import pgPromise from "pg-promise";

const app: Express = express();

const pgp = pgPromise({
    /* Initialization Options */
});

const db = pgp({
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    database: process.env.PG_DATABASE,
});

// const {value} = await db.one('SELECT 123 as value');

app.use(express.static('public'))
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // support encoded bodies
app.set("view engine", "pug");
app.set("views", "./src/views");

const port = process.env.PORT || 3000;
const apiVersion = process.env.API_VERSION || "v1";

interface Feed {
    id: string;
    title: string;
    description?: string;
    previewLinks?: string[];
}

app.get(
    "/",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const feeds: Feed[] = await db.any("SELECT * FROM feeds");
            res.render("index", { feeds });
        } catch (error: unknown) {
            next(new Error((error as Error).message));
        }
    }
);
app.get(
    "/feed/:id",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (!req.params.id || req.params.id === "") {
            next(new Error("Feed ID is required"));
            return;
        }

        try {
            const feed: Feed = await db.one("SELECT * FROM feeds WHERE id = $1", [
                req.params.id,
            ]);
            res.render("feed", { feed });
        } catch (error: unknown) {
            next(new Error((error as Error).message));
        }
    }
);

app.post(`/api/${apiVersion}/feed`, async (req: Request, res: Response) => {
    const { title, description } = req.body as { title: string; description: string };

    try {
        console .log(title, description);
        const response = await db.one("INSERT INTO feeds(title, description) VALUES($1, $2) RETURNING id", [title, description]);


        res.redirect(`/feed/${response.id}`);
        // res.status(201).send({ message: "Feed created successfully", id  });
        
    } catch (error) {
        console.log(error);
        res.status(500).send({ message: "Internal server error" });
        
    }
})
app.post(`/api/${apiVersion}/feed/:id`, async (req: Request, res: Response) => {
    const id = req.params.id;

    if (req.body.delete) {
        try {
            await db.none("DELETE FROM feeds WHERE id = $1", [id]);
            res.redirect(`/`);
            
        } catch (error) {
            console.log(error);
            res.status(500).send({ message: "Internal server error" });
            
        }
    }

})

app.listen(port, () => {
    console.log(`Server is up and running on port ${port}`);
});

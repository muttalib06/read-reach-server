const express = require("express");
require("dotenv").config();
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

// stripe
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = process.env.PORT || 3000;

// middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// firebase sdk initialize
const admin = require("firebase-admin");

const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// domain
const CLIENT_DOMAIN = "http://localhost:5173";

// generating tracking id;

const generateTrackingId = () => {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${timestamp}-${randomStr}`;
};

// mongodb connection

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ye0jqda.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// verify firebase token
const verifyFirebaseToken = async (req, res, next) => {
  // authHeader
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "Unauthorize" });
  }

  // extract token;
  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).send({ message: "Unauthorize" });
  }

  try {
    // verify firebase token
    const decoded = await admin.auth().verifyIdToken(token);
    console.log(decoded);

    // attach decoded info to request;
    req.user = decoded;
    next();
  } catch (error) {
    console.log(error);
    res.status(403).send({ message: "Forbidden" });
  }
};

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    //database and collection;
    const database = client.db("read_reach");
    const bookCollection = database.collection("books");
    const orderCollection = database.collection("orders");
    const paymentCollection = database.collection("payments");
    const userCollection = database.collection("users");

    // create role checking middleware;

    const verifyRole = (allowedRoles) => {
      return async (req, res, next) => {
        try {
          const email = req.user.email;
          const user = await userCollection.findOne({ email });
          console.log("after verify role", user);
          if (!user) {
            return res.status(401).send({ message: "Unauthorized access" });
          }
          if (!allowedRoles.includes(user.role)) {
            return res.status(403).send({ message: "Forbidden access" });
          }

          // attach user to the request ;

          req.dbUser = user;
          next();
        } catch (error) {
          console.error("Role verification error:", error);
          return res.status(500).send({ message: "Internal server error" });
        }
      };
    };

    //basic api;
    app.get("/", async (req, res) => {
      res.send("Read reach server is running perfectly");
    });

    // book related API;

    app.get("/latest-book", async (req, res) => {
      const cursor = bookCollection
        .find()
        .sort({ addedToLibraryDate: -1 })
        .limit(4);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/all-books", async (req, res) => {
      const query = { published_status: "published" };
      const cursor = bookCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/bookById/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await bookCollection.findOne(query);
      res.send(result);
    });

    app.get(
      "/books",
      verifyFirebaseToken,
      verifyRole(["admin"]),
      async (req, res) => {
        const cursor = bookCollection.find();
        const result = await cursor.toArray();
        res.send(result);
      }
    );

    app.get(
      "/librarian-book",
      verifyFirebaseToken,
      verifyRole(["librarian"]),
      async (req, res) => {
        const { email } = req.query;
        const query = { librarian_email: email };
        const result = await bookCollection.find(query).toArray();
        res.send(result);
      }
    );

    app.post(
      "/add-book",
      verifyFirebaseToken,
      verifyRole(["librarian"]),
      async (req, res) => {
        const book = req.body;
        const result = await bookCollection.insertOne(book);
        res.send(result);
      }
    );

    app.delete(
      "/delete-book/:bookId",
      verifyFirebaseToken,
      verifyRole(["admin"]),
      async (req, res) => {
        const bookId = req.params.bookId;
        const query = { _id: new ObjectId(bookId) };
        const orderQuery = { bookId: bookId };
        const result = await bookCollection.deleteOne(query);
        await orderCollection.deleteOne(orderQuery);
        res.send(result);
      }
    );

    app.patch(
      "/book-update/:bookId",
      verifyFirebaseToken,
      verifyRole(["librarian"]),
      async (req, res) => {
        const updatedData = req.body;
        const id = req.params.bookId;
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: updatedData,
        };
        const result = await bookCollection.updateOne(query, updateDoc);
        res.send(result);
      }
    );

    app.patch(
      "/publish-status-update/:bookId",
      verifyFirebaseToken,
      verifyRole(["librarian", "admin"]),
      async (req, res) => {
        const { published_status } = req.body;
        const bookId = req.params.bookId;
        const query = { _id: new ObjectId(bookId) };
        const updateDoc = {
          $set: {
            published_status: published_status,
          },
        };

        const result = await bookCollection.updateOne(query, updateDoc);
        res.send(result);
      }
    );

    // user related api

    app.post("/users", async (req, res) => {
      const user = req.body;
      const email = req.body.email;
      // prevent create  duplicate user;
      const existingUser = await userCollection.findOne({ email: email });
      if (existingUser) {
        return res.send({ message: "User already exists", user: existingUser });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.get(
      "/user",
      verifyFirebaseToken,
      verifyRole(["user", "librarian", "admin"]),
      async (req, res) => {
        const { email } = req.query;
        const query = {};
        if (email) {
          query.email = email;
        }
        const result = await userCollection.findOne(query);
        res.send(result);
      }
    );

    app.get(
      "/users",
      verifyFirebaseToken,
      verifyRole(["admin"]),
      async (req, res) => {
        const cursor = userCollection.find();
        const result = await cursor.toArray();
        res.send(result);
      }
    );

    app.get(
      "/fetch-role-based-user",
      verifyFirebaseToken,
      verifyRole(["admin"]),
      async (req, res) => {
        const { role } = req.query;
        const query = { role };
        const result = await userCollection.find(query).toArray();
        res.send(result);
      }
    );

    app.patch(
      "/update-user-role",
      verifyFirebaseToken,
      verifyRole(["admin"]),
      async (req, res) => {
        const { email } = req.query;
        const { roleOfUser } = req.body;
        const query = { email };
        const updateDoc = {
          $set: {
            role: roleOfUser,
          },
        };

        const result = await userCollection.updateOne(query, updateDoc);
        res.send(result);
      }
    );

    // payment related api

    app.get(
      "/all-payments",
      verifyFirebaseToken,
      verifyRole(["admin"]),
      async (req, res) => {
        const cursor = paymentCollection.find();
        const result = await cursor.toArray();
        res.send(result);
      }
    );

    app.get(
      "/payments",
      verifyFirebaseToken,
      verifyRole(["user"]),
      async (req, res) => {
        const emailQuery = req.query.email;
        const userEmail = req.user.email;
        const query = {};

        if (emailQuery) {
          query.email = emailQuery;

          // prevent a user from another user's orders;
          if (userEmail !== emailQuery) {
            return res.status(403).send({ message: "Forbidden access" });
          }
        }
        const cursor = paymentCollection.find(query);
        const result = await cursor.toArray();
        res.send(result);
      }
    );

    // order related api;
    app.get(
      "/all-orders",
      verifyFirebaseToken,
      verifyRole(["admin"]),
      async (req, res) => {
        const cursor = orderCollection.find();
        const result = await cursor.toArray();
        res.send(result);
      }
    );

    app.get(
      "/orders",
      verifyFirebaseToken,
      verifyRole(["user"]),
      async (req, res) => {
        const emailQuery = req.query.email;
        const userEmail = req.user.email;
        const query = {};

        if (emailQuery) {
          query.email = emailQuery;
          // prevent a user from another user's orders
          if (userEmail !== emailQuery) {
            return res.status(403).send({ message: "Forbidden access" });
          }
        }
        const cursor = orderCollection.find(query);
        const result = await cursor.toArray();
        res.send(result);
      }
    );

    app.get("/recent-orders", async (req, res) => {
      const { email } = req.query;
      const query = { email };
      const cursor = orderCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(5);
      const result = await cursor.toArray();
      res.send(result);
    });
    app.get("/delivered-orders", async (req, res) => {
      const { email } = req.query;
      const query = {};
      if (email) {
        query.email = email;
        query.status = "delivered";
      }
      const result = await orderCollection.find(query).toArray();
      res.send(result);
    });

    app.get(
      "/librarian-orders",
      verifyFirebaseToken,
      verifyRole(["librarian"]),
      async (req, res) => {
        const { email } = req.query;
        const query = { librarian_email: email };
        const result = await orderCollection.find(query).toArray();
        res.send(result);
      }
    );

    app.get("/three-orders", async (req, res) => {
      const { email } = req.query;
      const query = { email };
      const result = await orderCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(3)
        .toArray();
      res.send(result);
    });

    app.post("/order", async (req, res) => {
      const orderInfo = req.body;
      const result = await orderCollection.insertOne(orderInfo);
      res.send(result);
    });

    app.patch(
      "/order-status/:orderId",
      verifyFirebaseToken,
      verifyRole(["user"]),
      async (req, res) => {
        const { orderId } = req.params;
        const query = { _id: new ObjectId(orderId) };
        // update order status inside the order database;
        const updateDoc = {
          $set: {
            status: "cancelled",
          },
        };

        const result = await orderCollection.updateOne(query, updateDoc);
        res.send(result);
      }
    );

    app.patch(
      "/update-order-status/:orderId",
      verifyFirebaseToken,
      verifyRole(["librarian"]),
      async (req, res) => {
        const { orderStatus } = req.body;
        const orderId = req.params.orderId;
        const query = { _id: new ObjectId(orderId) };
        const updateDoc = {
          $set: {
            status: orderStatus,
          },
        };
        const result = await orderCollection.updateOne(query, updateDoc);
        res.send(result);
      }
    );

    // stripe payment features;

    // create checkout session;

    app.post("/create-checkout-session", async (req, res) => {
      try {
        const { orderName, email, price, bookId } = req.body;
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: orderName,
                },
                unit_amount: parseInt(price) * 100,
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          customer_email: email,
          metadata: {
            orderId: bookId,
            bookName: orderName,
          },

          success_url: `${CLIENT_DOMAIN}/dashboard/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${CLIENT_DOMAIN}/cancel`,
        });

        res.json({
          url: session.url,
        });
      } catch (error) {
        console.log("Error creating checkout session", error);
        res.status(500).send(error);
      }
    });

    // payment verification and update

    // app.get("/payment-status/:paymentIntentId", async (req, res) => {
    //   try {
    //     const { paymentIntentId } = req.params;
    //     // retrieve session from stripe;
    //     const session = await stripe.checkout.sessions.retrieve(
    //       paymentIntentId
    //     );
    //     console.log("session result", session);

    //     // save payment info to the database;

    //     const paymentInfo = {
    //       transactionId: session.payment_intent,
    //       createdAt: new Date(),
    //       amount: session.amount_total,
    //       bookName: session.metadata.bookName,
    //       email: session.customer_email,
    //     };

    //     // prevent duplicate payment data;

    //     const existingPayment = await paymentCollection.findOne({
    //       transactionId: session.payment_intent,
    //     });

    //     if (!existingPayment) {
    //       await paymentCollection.insertOne(paymentInfo);
    //     }

    //     // update payment status inside order data;

    //     if (session.payment_status === "paid") {
    //       const orderId = session.metadata.orderId;
    //       const query = { _id: new ObjectId(orderId) };
    //       const updateDoc = {
    //         $set: {
    //           payment: "paid",
    //           status: "processing",
    //         },
    //       };
    //       await orderCollection.updateOne(query, updateDoc);
    //     }

    //     // send session to the client
    //     res.json(session);
    //   } catch (error) {
    //     console.error("Payment status error:", error);
    //     res.status(500).json({ error: "Failed to retrieve payment status" });
    //   }
    // });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    //     await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Read reach app listening on port ${port}`);
});

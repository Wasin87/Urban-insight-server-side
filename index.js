const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

let stripe;
try {
    if (!process.env.STRIPE_SECRET_KEY) {
        console.error('STRIPE_SECRET_KEY is not set in environment variables');
    } else {
        stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        console.log('✅ Stripe initialized successfully');
    }
} catch (error) {
    console.error('Stripe initialization error:', error.message);
    stripe = null;
}

const app = express();
const port = process.env.PORT || 3000;

 
app.use(cors({
    origin: ['http://localhost:5173', 'https://urban-insight-client.vercel.app'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));

app.use(express.json());

// MongoDB URI - Using environment variable
const uri = process.env.MONGODB_URI || `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@wasin3.w2xfr9.mongodb.net/Urban_insight_db?retryWrites=true&w=majority&appName=Wasin3`;

const client = new MongoClient(uri, { 
    serverApi: { 
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true 
    }
});

let issuesCollection;
let usersCollection;
let paymentsCollection;

async function run() {
    try {
        // await client.connect();
        console.log("✅ MongoDB Connected Successfully");
        
        const db = client.db('Urban_insight_db');

        issuesCollection = db.collection('issues');
        usersCollection = db.collection('users');
        paymentsCollection = db.collection('payments');

        console.log("✅ Collections initialized");

    } catch (err) {
        console.error('❌ MongoDB connection error:', err.message);
        // Don't throw error, let server continue running
    }
}

run().catch(console.dir);

// Add delay to ensure MongoDB connects before handling requests
setTimeout(() => {
    console.log("🚀 Server ready to handle requests");
}, 1000);

// USER API
// Create user
app.post('/users', async (req, res) => {
    try {
        const user = req.body;
        const existingUser = await usersCollection.findOne({ email: user.email });
        if (existingUser) return res.send({ success: true, message: "User already exists" });

        user.role = "user";
        user.isPremium = false;
        user.premiumExpiresAt = null;
        user.maxIssues = 3;
        user.createdAt = new Date();
        user.updatedAt = new Date();
        user.status = 'active';

        const result = await usersCollection.insertOne(user);
        res.send({ 
            success: true, 
            insertedId: result.insertedId,
            message: "User created successfully"
        });
    } catch (error) {
        console.error("User Insert Error:", error);
        res.status(500).send({ success: false, error: error.message });
    }
});

app.get('/users', async (req, res) => {
    try {
        const { searchText, role } = req.query;
        let query = {};

        if (searchText) {
            query.$or = [
                { displayName: { $regex: searchText, $options: 'i' } },
                { email: { $regex: searchText, $options: 'i' } }
            ];
        }

        if (role && role !== 'all') {
            query.role = role;
        }

        const users = await usersCollection.find(query).toArray();
        res.send(users);
    } catch (error) {
        console.error("Get Users Error:", error);
        res.status(500).send({ success: false, error: error.message });
    }
});

app.get('/users/:email', async (req, res) => {
    try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email });
        
        if (!user) {
            return res.status(404).send({ 
                success: false, 
                message: "User not found" 
            });
        }

        const issueCount = await issuesCollection.countDocuments({ 
            submittedBy: email 
        });

        let isPremium = user.isPremium || false;
        if (user.premiumExpiresAt && new Date(user.premiumExpiresAt) < new Date()) {
            isPremium = false;
            await usersCollection.updateOne(
                { email },
                { 
                    $set: { 
                        isPremium: false,
                        updatedAt: new Date()
                    } 
                }
            );
        }

        res.send({
            ...user,
            issueCount,
            canReportMore: isPremium ? true : issueCount < 3,
            remainingIssues: isPremium ? 'unlimited' : Math.max(0, 3 - issueCount)
        });
    } catch (error) {
        console.error("Get User Error:", error);
        res.status(500).send({ success: false, error: error.message });
    }
});

// Update user role
app.patch('/users/:id/role', async (req, res) => {
    try {
        const id = req.params.id;
        const { role } = req.body;
        
        const validRoles = ['user', 'admin', 'staff', 'rejected', 'blocked'];
        if (!validRoles.includes(role)) {
            return res.status(400).send({ 
                success: false, 
                error: 'Invalid role. Valid roles are: user, admin, staff, rejected, blocked' 
            });
        }

        const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { 
                $set: { 
                    role: role,
                    updatedAt: new Date(),
                    status: role === 'blocked' || role === 'rejected' ? 'inactive' : 'active'
                } 
            }
        );

        if (result.matchedCount === 0) {
            return res.status(404).send({ 
                success: false, 
                error: 'User not found' 
            });
        }

        const updatedUser = await usersCollection.findOne({ _id: new ObjectId(id) });

        res.send({
            success: true,
            message: `User role updated to ${role}`,
            modifiedCount: result.modifiedCount,
            user: {
                _id: updatedUser._id,
                email: updatedUser.email,
                displayName: updatedUser.displayName,
                role: updatedUser.role,
                isPremium: updatedUser.isPremium
            }
        });

    } catch (error) {
        console.error("Update User Role Error:", error);
        res.status(500).send({ success: false, error: error.message });
    }
});

// Update user by ID
app.patch('/users/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const updateData = req.body;
        updateData.updatedAt = new Date();

        if (updateData.role) {
            updateData.status = (updateData.role === 'blocked' || updateData.role === 'rejected') ? 'inactive' : 'active';
        }

        const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateData }
        );

        if (result.matchedCount === 0) {
            return res.status(404).send({ 
                success: false, 
                error: 'User not found' 
            });
        }

        res.send({
            success: true,
            message: 'User updated successfully',
            modifiedCount: result.modifiedCount
        });

    } catch (error) {
        console.error("Update User Error:", error);
        res.status(500).send({ success: false, error: error.message });
    }
});

// Delete user
app.delete('/users/:id', async (req, res) => {
    try {
        const id = req.params.id;
        
        const user = await usersCollection.findOne({ _id: new ObjectId(id) });
        if (!user) {
            return res.status(404).send({ 
                success: false, 
                error: 'User not found' 
            });
        }

        const result = await usersCollection.deleteOne({ _id: new ObjectId(id) });
        await issuesCollection.deleteMany({ submittedBy: user.email });
        await paymentsCollection.deleteMany({ userEmail: user.email });

        res.send({
            success: true,
            message: 'User and all associated data deleted successfully',
            deletedCount: result.deletedCount
        });

    } catch (error) {
        console.error("Delete User Error:", error);
        res.status(500).send({ success: false, error: error.message });
    }
});

// Update user premium status
app.patch('/users/:email/premium', async (req, res) => {
    try {
        const email = req.params.email;
        const { plan, expiresAt, paymentId } = req.body;

        const updateData = {
            isPremium: true,
            premiumPlan: plan,
            premiumExpiresAt: expiresAt,
            premiumPaymentId: paymentId,
            updatedAt: new Date()
        };

        const result = await usersCollection.updateOne(
            { email },
            { $set: updateData }
        );

        if (result.matchedCount === 0) {
            return res.status(404).send({ 
                success: false, 
                error: 'User not found' 
            });
        }

        res.send({
            success: true,
            message: 'User premium status updated successfully'
        });

    } catch (error) {
        console.error('Update premium error:', error);
        res.status(500).send({ 
            success: false, 
            error: 'Failed to update premium status' 
        });
    }
});

// ISSUES API
// GET all issues or by email - Boosted issues first
app.get('/issues', async (req, res) => {
    try {
        const { email, status, district } = req.query;
        let query = {};
        
        if (email) query.submittedBy = email;
        if (status) {
            if (status === 'boosted') {
                query.isBoosted = true;
            } else {
                query.status = status;
            }
        }
        if (district) {
            query.district = district;
        }
        
        const result = await issuesCollection.find(query).toArray();
        
        result.sort((a, b) => {
            if (a.isBoosted && !b.isBoosted) return -1;
            if (!a.isBoosted && b.isBoosted) return 1;
            return new Date(b.createdAt) - new Date(a.createdAt);
        });
        
        res.send(result);
    } catch (error) {
        console.error('Error fetching issues:', error);
        res.status(500).send({ success: false, error: error.message });
    }
});

// GET single issue by ID
app.get('/issues/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
        if (!issue) return res.status(404).send({ success: false, message: "Issue not found" });
        res.send(issue);
    } catch (error) {
        console.error("Get Issue Error:", error);
        res.status(500).send({ success: false, error: error.message });
    }
});

// POST create new issue with role and premium check
app.post('/issues', async (req, res) => {
    try {
        const issueData = req.body;
        const userEmail = issueData.submittedBy;

        const user = await usersCollection.findOne({ email: userEmail });
        if (!user) {
            return res.status(404).send({ 
                success: false, 
                error: 'User not found' 
            });
        }

        if (user.role === 'blocked' || user.role === 'rejected') {
            return res.status(403).send({
                success: false,
                error: 'Your account is restricted from reporting issues',
                role: user.role
            });
        }

        const userIssueCount = await issuesCollection.countDocuments({ 
            submittedBy: userEmail 
        });

        const isPremium = user.isPremium || false;
        const premiumExpired = user.premiumExpiresAt && new Date(user.premiumExpiresAt) < new Date();

        const isStaffOrAdmin = user.role === 'staff' || user.role === 'admin';

        if (!isStaffOrAdmin && (!isPremium || premiumExpired)) {
            if (userIssueCount >= 3) {
                return res.status(400).send({
                    success: false,
                    error: 'Maximum issue limit reached. Upgrade to premium for unlimited reports.',
                    limitReached: true,
                    currentCount: userIssueCount,
                    maxLimit: 3
                });
            }
        }

        issueData.status = 'pending';
        issueData.isBoosted = false;
        issueData.upvotes = 0;
        issueData.upvotedBy = [];
        issueData.createdAt = new Date();
        issueData.updatedAt = new Date();
        issueData.submittedByRole = user.role;

        const result = await issuesCollection.insertOne(issueData);
        
        res.send({ 
            success: true, 
            insertedId: result.insertedId,
            message: "Issue created successfully",
            userIssueCount: userIssueCount + 1,
            userRole: user.role,
            isPremium: isPremium && !premiumExpired
        });
    } catch (error) {
        console.error('Error inserting issue:', error);
        res.status(500).send({ success: false, error: error.message });
    }
});

// PATCH update issue by ID
app.patch('/issues/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const updatedData = req.body;
        updatedData.updatedAt = new Date();

        const result = await issuesCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updatedData }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).send({ success: false, message: "Issue not found" });
        }
        
        res.send({ 
            success: true, 
            modifiedCount: result.modifiedCount,
            message: "Issue updated successfully"
        });
    } catch (error) {
        console.error('Update Issue Error:', error);
        res.status(500).send({ success: false, error: error.message });
    }
});

// PATCH update issue status
app.patch('/issues/:id/status', async (req, res) => {
    try {
        const id = req.params.id;
        const { status, updatedAt } = req.body;
        
        const validStatuses = ['pending', 'assigned', 'in-progress', 'resolved', 'rejected'];
        if (!validStatuses.includes(status)) {
            return res.status(400).send({ 
                success: false, 
                error: 'Invalid status. Valid statuses are: pending, assigned, in-progress, resolved, rejected' 
            });
        }

        const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
        if (!issue) {
            return res.status(404).send({ 
                success: false, 
                error: 'Issue not found' 
            });
        }

        const updateData = {
            status: status,
            updatedAt: updatedAt || new Date()
        };

        if (status === 'resolved') {
            updateData.resolvedAt = new Date();
        }

        if (status === 'rejected') {
            updateData.rejectedAt = new Date();
            updateData.rejectedBy = issue.assignedStaffEmail;
        }

        const result = await issuesCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateData }
        );

        if (result.matchedCount === 0) {
            return res.status(400).send({ 
                success: false, 
                error: 'Failed to update issue status' 
            });
        }

        if (status === 'resolved' || status === 'rejected') {
            if (issue.assignedStaffId) {
                await usersCollection.updateOne(
                    { _id: issue.assignedStaffId },
                    { 
                        $inc: { 
                            resolvedIssuesCount: status === 'resolved' ? 1 : 0,
                            rejectedIssuesCount: status === 'rejected' ? 1 : 0
                        },
                        $set: { updatedAt: new Date() }
                    }
                );
            }
        }

        res.send({
            success: true,
            message: `Issue status updated to ${status} successfully`,
            modifiedCount: result.modifiedCount,
            issue: {
                id: id,
                title: issue.issueTitle,
                status: status
            }
        });

    } catch (error) {
        console.error('Update Issue Status Error:', error);
        res.status(500).send({ 
            success: false, 
            error: 'Failed to update issue status: ' + error.message 
        });
    }
});

// PATCH assign staff to issue
app.patch('/issues/:id/assign-staff', async (req, res) => {
    try {
        const id = req.params.id;
        const { 
            assignedStaffId, 
            assignedStaffEmail, 
            assignedStaffName,
            assignedAt 
        } = req.body;

        const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
        if (!issue) {
            return res.status(404).send({ 
                success: false, 
                error: 'Issue not found' 
            });
        }

        const staff = await usersCollection.findOne({ 
            _id: new ObjectId(assignedStaffId),
            role: 'staff'
        });
        if (!staff) {
            return res.status(404).send({ 
                success: false, 
                error: 'Staff member not found or not a valid staff' 
            });
        }

        const updateData = {
            status: 'assigned',
            assignedStaffId: new ObjectId(assignedStaffId),
            assignedStaffEmail: assignedStaffEmail,
            assignedStaffName: assignedStaffName,
            assignedAt: assignedAt || new Date(),
            updatedAt: new Date()
        };

        const result = await issuesCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateData }
        );

        if (result.modifiedCount === 0) {
            return res.status(400).send({ 
                success: false, 
                error: 'Failed to assign staff to issue' 
            });
        }

        await usersCollection.updateOne(
            { _id: new ObjectId(assignedStaffId) },
            { 
                $inc: { assignedIssuesCount: 1 },
                $push: { 
                    assignedIssues: {
                        issueId: new ObjectId(id),
                        issueTitle: issue.issueTitle,
                        assignedAt: new Date(),
                        status: 'assigned'
                    }
                },
                $set: { updatedAt: new Date() }
            }
        );

        res.send({
            success: true,
            message: 'Staff assigned to issue successfully',
            modifiedCount: result.modifiedCount,
            assignedStaff: {
                id: assignedStaffId,
                email: assignedStaffEmail,
                name: assignedStaffName
            },
            issue: {
                id: id,
                title: issue.issueTitle,
                status: 'assigned'
            }
        });

    } catch (error) {
        console.error('Assign Staff Error:', error);
        res.status(500).send({ 
            success: false, 
            error: 'Failed to assign staff: ' + error.message 
        });
    }
});

// PATCH update issue boost status
app.patch('/issues/:id/boost', async (req, res) => {
    try {
        const id = req.params.id;
        const { boostPaymentId } = req.body;

        const updateData = {
            isBoosted: true,
            boostedAt: new Date(),
            boostPaymentId: new ObjectId(boostPaymentId),
            updatedAt: new Date()
        };

        const result = await issuesCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateData }
        );

        if (result.matchedCount === 0) {
            return res.status(404).send({ 
                success: false, 
                error: 'Issue not found' 
            });
        }

        res.send({
            success: true,
            message: 'Issue boosted successfully',
            modifiedCount: result.modifiedCount
        });

    } catch (error) {
        console.error('Boost issue error:', error);
        res.status(500).send({ 
            success: false, 
            error: 'Failed to boost issue' 
        });
    }
});

// DELETE issue by ID
app.delete('/issues/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const result = await issuesCollection.deleteOne({ _id: new ObjectId(id) });
        
        if (result.deletedCount === 0) {
            return res.status(404).send({ success: false, message: "Issue not found" });
        }
        
        await paymentsCollection.deleteMany({ issueId: id });
        
        res.send({ 
            success: true, 
            deletedCount: result.deletedCount,
            message: "Issue deleted successfully"
        });
    } catch (error) {
        console.error('Delete Issue Error:', error);
        res.status(500).send({ success: false, error: error.message });
    }
});

// GET staff's assigned issues
app.get('/staff/:staffId/issues', async (req, res) => {
    try {
        const staffId = req.params.staffId;
        
        const issues = await issuesCollection.find({
            assignedStaffId: new ObjectId(staffId)
        }).toArray();

        res.send({
            success: true,
            count: issues.length,
            issues: issues
        });
    } catch (error) {
        console.error('Get staff issues error:', error);
        res.status(500).send({ 
            success: false, 
            error: 'Failed to fetch staff issues' 
        });
    }
});

// PAYMENT APIs
// Create premium payment checkout session
app.post('/create-premium-payment', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).send({ 
                success: false, 
                error: 'Stripe payment service is not configured.' 
            });
        }

        const { amount, userEmail, userName, type = 'premium', plan = 'monthly' } = req.body;
        
        if (!amount || !userEmail) {
            return res.status(400).send({ 
                success: false, 
                error: 'Missing required payment information' 
            });
        }

        const user = await usersCollection.findOne({ email: userEmail });
        if (!user) {
            return res.status(404).send({ 
                success: false, 
                error: 'User not found' 
            });
        }

        const clientUrl = process.env.SITE_DOMAIN || 'http://localhost:5173';

        const expiresAt = new Date();
        if (plan === 'monthly') {
            expiresAt.setMonth(expiresAt.getMonth() + 1);
        } else if (plan === 'yearly') {
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'bdt',
                        product_data: {
                            name: `Urban Insight Premium - ${plan === 'monthly' ? 'Monthly' : 'Yearly'} Plan`,
                            description: 'Unlock unlimited issue reporting and premium features',
                            images: []
                        },
                        unit_amount: Math.round(amount * 100),
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            metadata: {
                userEmail: userEmail,
                userName: userName || userEmail,
                type: type,
                plan: plan,
                amount: amount.toString(),
                expiresAt: expiresAt.toISOString()
            },
            customer_email: userEmail,
            success_url: `${clientUrl}/premium-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${clientUrl}/premium-cancel`,
            billing_address_collection: 'required',
            shipping_address_collection: {
                allowed_countries: ['BD'],
            },
            custom_text: {
                submit: {
                    message: "You'll be redirected to complete your premium subscription"
                }
            }
        });

        console.log(`✅ Premium payment session created for ${userEmail}:`, session.id);

        res.send({ 
            success: true, 
            url: session.url,
            sessionId: session.id
        });

    } catch (error) {
        console.error('❌ Premium payment session error:', error);
        res.status(500).send({ 
            success: false, 
            error: error.message || 'Failed to create premium payment session.' 
        });
    }
});

// Verify premium payment and update user
app.get('/premium-verify', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).send({ 
                success: false, 
                error: 'Stripe payment service is not configured' 
            });
        }

        const { session_id } = req.query;
        
        if (!session_id) {
            return res.status(400).send({ 
                success: false, 
                error: 'Session ID is required' 
            });
        }

        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status !== 'paid') {
            return res.status(400).send({ 
                success: false, 
                error: 'Payment not completed' 
            });
        }

        const existingPayment = await paymentsCollection.findOne({ 
            stripeSessionId: session_id 
        });

        if (existingPayment) {
            return res.send({
                success: true,
                message: 'Payment already processed',
                payment: existingPayment
            });
        }

        const { userEmail, userName, type, plan, amount, expiresAt } = session.metadata;

        const paymentData = {
            transactionId: session.payment_intent,
            amount: parseFloat(amount),
            currency: session.currency,
            userEmail: userEmail,
            userName: userName,
            type: type,
            plan: plan,
            status: 'completed',
            paidAt: new Date(),
            stripeSessionId: session.id,
            customerDetails: {
                email: session.customer_details?.email,
                name: session.customer_details?.name
            }
        };

        const paymentResult = await paymentsCollection.insertOne(paymentData);

        const updateResult = await usersCollection.updateOne(
            { email: userEmail },
            {
                $set: {
                    isPremium: true,
                    premiumPlan: plan,
                    premiumExpiresAt: new Date(expiresAt),
                    premiumPaymentId: paymentResult.insertedId,
                    updatedAt: new Date()
                }
            }
        );

        if (updateResult.matchedCount > 0) {
            console.log(`✅ User ${userEmail} upgraded to premium successfully`);
            
            res.send({
                success: true,
                message: 'Payment verified and user upgraded to premium successfully',
                payment: {
                    ...paymentData,
                    _id: paymentResult.insertedId
                },
                userUpdated: true,
                expiresAt: new Date(expiresAt)
            });
        } else {
            await paymentsCollection.deleteOne({ _id: paymentResult.insertedId });
            res.status(500).send({
                success: false,
                error: 'Failed to update user premium status'
            });
        }

    } catch (error) {
        console.error('❌ Premium payment verification error:', error);
        res.status(500).send({ 
            success: false, 
            error: 'Premium payment verification failed: ' + error.message 
        });
    }
});

// Create boost payment checkout session
app.post('/create-boost-payment', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).send({ 
                success: false, 
                error: 'Stripe payment service is not configured.' 
            });
        }

        const { amount, issueId, userEmail, issueTitle, type = 'boost' } = req.body;
        
        if (!amount || !issueId || !userEmail || !issueTitle) {
            return res.status(400).send({ 
                success: false, 
                error: 'Missing required payment information' 
            });
        }

        const issue = await issuesCollection.findOne({ _id: new ObjectId(issueId) });
        if (!issue) {
            return res.status(404).send({ 
                success: false, 
                error: 'Issue not found' 
            });
        }

        if (issue.isBoosted) {
            return res.status(400).send({ 
                success: false, 
                error: 'This issue is already boosted' 
            });
        }

        if (issue.submittedBy !== userEmail) {
            return res.status(403).send({ 
                success: false, 
                error: 'Only the issue owner can boost this issue' 
            });
        }

        if (issue.status !== 'pending') {
            return res.status(400).send({ 
                success: false, 
                error: 'Only pending issues can be boosted' 
            });
        }

        const clientUrl = process.env.SITE_DOMAIN || 'http://localhost:5173';

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'bdt',
                        product_data: {
                            name: `Boost Issue: ${issueTitle.substring(0, 50)}`,
                            description: 'Priority boost for community issue visibility',
                            images: issue.images && issue.images[0] ? [issue.images[0]] : []
                        },
                        unit_amount: Math.round(amount * 100),
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            metadata: {
                issueId: issueId,
                issueTitle: issueTitle,
                userEmail: userEmail,
                type: type,
                amount: amount
            },
            customer_email: userEmail,
            success_url: `${clientUrl}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${clientUrl}/dashboard/payment-cancelled`,
            billing_address_collection: 'required',
            shipping_address_collection: {
                allowed_countries: ['BD'],
            },
            custom_text: {
                submit: {
                    message: "You'll be redirected to complete your payment securely"
                }
            }
        });

        console.log('✅ Boost payment session created:', session.id);

        res.send({ 
            success: true, 
            url: session.url,
            sessionId: session.id
        });

    } catch (error) {
        console.error('❌ Boost payment session error:', error);
        res.status(500).send({ 
            success: false, 
            error: error.message || 'Failed to create payment session.' 
        });
    }
});

// Verify boost payment and update issue
app.get('/payment-verify', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).send({ 
                success: false, 
                error: 'Stripe payment service is not configured' 
            });
        }

        const { session_id } = req.query;
        
        if (!session_id) {
            return res.status(400).send({ 
                success: false, 
                error: 'Session ID is required' 
            });
        }

        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status !== 'paid') {
            return res.status(400).send({ 
                success: false, 
                error: 'Payment not completed' 
            });
        }

        const existingPayment = await paymentsCollection.findOne({ 
            stripeSessionId: session_id 
        });

        if (existingPayment) {
            return res.send({
                success: true,
                message: 'Payment already processed',
                payment: existingPayment
            });
        }

        const { issueId, issueTitle, userEmail, type, amount } = session.metadata;

        const paymentData = {
            transactionId: session.payment_intent,
            amount: parseFloat(amount),
            currency: session.currency,
            userEmail: userEmail,
            issueId: issueId,
            issueTitle: issueTitle,
            type: type,
            status: 'completed',
            paidAt: new Date(),
            stripeSessionId: session.id,
            customerDetails: {
                email: session.customer_details?.email,
                name: session.customer_details?.name
            }
        };

        const paymentResult = await paymentsCollection.insertOne(paymentData);

        const updateResult = await issuesCollection.updateOne(
            { _id: new ObjectId(issueId) },
            {
                $set: {
                    isBoosted: true,
                    boostedAt: new Date(),
                    boostPaymentId: paymentResult.insertedId,
                    updatedAt: new Date()
                }
            }
        );

        if (updateResult.modifiedCount > 0) {
            console.log(`✅ Issue ${issueId} boosted successfully`);
            
            res.send({
                success: true,
                message: 'Payment verified and issue boosted successfully',
                payment: {
                    ...paymentData,
                    _id: paymentResult.insertedId
                },
                issueUpdated: true
            });
        } else {
            await paymentsCollection.deleteOne({ _id: paymentResult.insertedId });
            res.status(500).send({
                success: false,
                error: 'Failed to update issue status'
            });
        }

    } catch (error) {
        console.error('❌ Payment verification error:', error);
        res.status(500).send({ 
            success: false, 
            error: 'Payment verification failed: ' + error.message 
        });
    }
});

// Get user payment history
app.get('/payments', async (req, res) => {
    try {
        const { email } = req.query;
        
        if (!email) {
            return res.status(400).send({ 
                success: false, 
                error: 'Email is required' 
            });
        }

        const payments = await paymentsCollection
            .find({ userEmail: email })
            .sort({ paidAt: -1 })
            .toArray();

        res.send({
            success: true,
            payments: payments,
            count: payments.length
        });

    } catch (error) {
        console.error('Get payments error:', error);
        res.status(500).send({ 
            success: false, 
            error: 'Failed to fetch payment history' 
        });
    }
});

// Get payment by ID
app.get('/payments/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const payment = await paymentsCollection.findOne({ 
            _id: new ObjectId(id) 
        });

        if (!payment) {
            return res.status(404).send({ 
                success: false, 
                error: 'Payment not found' 
            });
        }

        res.send({
            success: true,
            payment: payment
        });

    } catch (error) {
        console.error('Get payment error:', error);
        res.status(500).send({ 
            success: false, 
            error: 'Failed to fetch payment details' 
        });
    }
});

// ADDITIONAL API ENDPOINTS
// Get user's issue count and premium status
app.get('/user-stats/:email', async (req, res) => {
    try {
        const email = req.params.email;
        
        const user = await usersCollection.findOne({ email });
        if (!user) {
            return res.status(404).send({ 
                success: false, 
                error: 'User not found' 
            });
        }

        const issueCount = await issuesCollection.countDocuments({ 
            submittedBy: email 
        });

        let isPremium = user.isPremium || false;
        if (user.premiumExpiresAt && new Date(user.premiumExpiresAt) < new Date()) {
            isPremium = false;
        }

        res.send({
            success: true,
            email: email,
            isPremium: isPremium,
            premiumExpiresAt: user.premiumExpiresAt,
            issueCount: issueCount,
            maxIssues: isPremium ? 'unlimited' : 3,
            remainingIssues: isPremium ? 'unlimited' : Math.max(0, 3 - issueCount),
            canReportMore: isPremium ? true : issueCount < 3,
            role: user.role,
            status: user.status
        });

    } catch (error) {
        console.error('Get user stats error:', error);
        res.status(500).send({ 
            success: false, 
            error: 'Failed to get user stats' 
        });
    }
});

// Get all premium users
app.get('/premium-users', async (req, res) => {
    try {
        const premiumUsers = await usersCollection
            .find({ isPremium: true })
            .toArray();

        res.send({
            success: true,
            count: premiumUsers.length,
            users: premiumUsers
        });
    } catch (error) {
        console.error('Get premium users error:', error);
        res.status(500).send({ 
            success: false, 
            error: 'Failed to get premium users' 
        });
    }
});

// Get users by role
app.get('/users-by-role/:role', async (req, res) => {
    try {
        const role = req.params.role;
        const users = await usersCollection
            .find({ role: role })
            .toArray();

        res.send({
            success: true,
            count: users.length,
            users: users
        });
    } catch (error) {
        console.error('Get users by role error:', error);
        res.status(500).send({ 
            success: false, 
            error: 'Failed to get users by role' 
        });
    }
});

// Get staff performance stats
app.get('/staff-stats', async (req, res) => {
    try {
        const staffMembers = await usersCollection
            .find({ role: 'staff' })
            .toArray();

        const stats = await Promise.all(staffMembers.map(async (staff) => {
            const assignedIssues = await issuesCollection.countDocuments({
                assignedStaffId: staff._id
            });
            
            const resolvedIssues = await issuesCollection.countDocuments({
                assignedStaffId: staff._id,
                status: 'resolved'
            });

            const rejectedIssues = await issuesCollection.countDocuments({
                assignedStaffId: staff._id,
                status: 'rejected'
            });

            return {
                ...staff,
                assignedIssues,
                resolvedIssues,
                rejectedIssues,
                successRate: assignedIssues > 0 ? Math.round((resolvedIssues / assignedIssues) * 100) : 0,
                completionRate: assignedIssues > 0 ? Math.round(((resolvedIssues + rejectedIssues) / assignedIssues) * 100) : 0
            };
        }));

        res.send({
            success: true,
            count: stats.length,
            staffStats: stats
        });
    } catch (error) {
        console.error('Get staff stats error:', error);
        res.status(500).send({ 
            success: false, 
            error: 'Failed to get staff statistics' 
        });
    }
});

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        const usersCount = await usersCollection.countDocuments();
        const issuesCount = await issuesCollection.countDocuments();
        const paymentsCount = await paymentsCollection.countDocuments();
        const staffCount = await usersCollection.countDocuments({ role: 'staff' });
        const pendingIssuesCount = await issuesCollection.countDocuments({ status: 'pending' });
        const assignedIssuesCount = await issuesCollection.countDocuments({ status: 'assigned' });
        const inProgressIssuesCount = await issuesCollection.countDocuments({ status: 'in-progress' });
        const resolvedIssuesCount = await issuesCollection.countDocuments({ status: 'resolved' });
        const rejectedIssuesCount = await issuesCollection.countDocuments({ status: 'rejected' });
        
        res.send({
            status: 'healthy',
            timestamp: new Date(),
            database: 'connected',
            stripe: stripe ? 'configured' : 'not configured',
            collections: {
                users: usersCount,
                issues: issuesCount,
                payments: paymentsCount
            },
            stats: {
                staff: staffCount,
                pendingIssues: pendingIssuesCount,
                assignedIssues: assignedIssuesCount,
                inProgressIssues: inProgressIssuesCount,
                resolvedIssues: resolvedIssuesCount,
                rejectedIssues: rejectedIssuesCount
            },
            roles: ['user', 'admin', 'staff', 'rejected', 'blocked'],
            issueStatuses: ['pending', 'assigned', 'in-progress', 'resolved', 'rejected']
        });
    } catch (error) {
        res.status(500).send({
            status: 'unhealthy',
            timestamp: new Date(),
            error: error.message
        });
    }
});

// Root endpoint
app.get('/', (req, res) => {
    res.json("Server is connecting.");
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).send({ 
        success: false, 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// FIXED 404 handler - use a regular expression instead of '*'
app.use((req, res) => {
    res.status(404).send({
        success: false,
        error: 'Endpoint not found',
        message: `The route ${req.originalUrl} does not exist on this server`,
        availableEndpoints: [
            'GET /',
            'GET /health',
            'GET /issues',
            'GET /issues/:id',
            'POST /issues',
            'PATCH /issues/:id',
            'DELETE /issues/:id',
            'GET /users',
            'GET /users/:email',
            'POST /users',
            'PATCH /users/:id',
            'DELETE /users/:id'
        ]
    });
});

// Start server
app.listen(port, () => {
    console.log(`🚀 Server listening on port ${port}`);
    console.log(`📡 Environment: ${process.env.NODE_ENV}`);
    console.log(`🔗 API Base URL: http://localhost:${port}`);
});
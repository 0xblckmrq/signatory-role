require("dotenv").config();
const path = require("path");
const express = require("express");
const { Client, GatewayIntentBits, REST, Routes, PermissionsBitField, ChannelType, SlashCommandBuilder } = require("discord.js");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { ethers } = require("ethers");

// ================== CONFIG ==================
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const API_KEY = process.env.WHITELIST_API_KEY;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !API_KEY || !EXTERNAL_URL) {
  console.error("BOT_TOKEN, CLIENT_ID, GUILD_ID, WHITELIST_API_KEY, or RENDER_EXTERNAL_URL not set");
  process.exit(1);
}

const API_URL = "http://manifest.human.tech/api/covenant/signers-export";

// ================== HTTP SERVER ==================
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.get("/", (req, res) => res.send("Bot running"));
app.listen(PORT, () => console.log(`HTTP server running on port ${PORT}`));

// ================== DISCORD CLIENT ==================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ========== COOLDOWN & CHALLENGES ==========
const challenges = new Map();
const cooldowns = new Map();
const COOLDOWN_SECONDS = 300; // 5 minutes

// ---------------- REGISTER SLASH COMMANDS ----------------
(async () => {
  const commands = [
    new SlashCommandBuilder()
      .setName("verify")
      .setDescription("Start wallet verification")
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("Slash commands registered");
})();

// ---------------- HELPERS ----------------
async function fetchWhitelist() {
  const res = await fetch(`${API_URL}?apiKey=${API_KEY}`);
  const json = await res.json();
  return json.signers || [];
}

// ---------------- CLIENT EVENTS ----------------
client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "verify") {
    const userId = interaction.user.id;
    const guild = interaction.guild;
    const member = interaction.member;

    // Cooldown
    const last = cooldowns.get(userId) || 0;
    const now = Date.now();
    if (now - last < COOLDOWN_SECONDS * 1000) {
      const remaining = Math.ceil((COOLDOWN_SECONDS * 1000 - (now - last)) / 1000);
      const msg = `⏳ You can use /verify again in ${remaining} seconds.`;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: msg, ephemeral: true });
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
      return;
    }
    cooldowns.set(userId, now);

    try {
      // Fetch whitelist and pick first eligible SIGNED + VERIFIED wallet
      const list = await fetchWhitelist();
      const entry = list.find(
        w => w.humanityStatus?.toUpperCase() === "VERIFIED" && w.covenantStatus?.toUpperCase() === "SIGNED"
      );

      if (!entry) {
        const msg = "❌ No eligible wallet found for verification (must be SIGNED + VERIFIED).";
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: msg, ephemeral: true });
        } else {
          await interaction.reply({ content: msg, ephemeral: true });
        }
        return;
      }

      const wallet = entry.walletAddress.toLowerCase();

      // Create private verification channel
      const channel = await guild.channels.create({
        name: `verify-${member.user.username}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        ],
      });

      // Generate challenge
      const challenge = `Verify ownership for ${wallet} at ${Date.now()}`;
      challenges.set(member.id, { challenge, wallet });

      // Signer URL auto-fills wallet & userId
      const signerUrl = `${EXTERNAL_URL.replace(/\/$/, "")}/signer.html?userId=${member.id}&challenge=${encodeURIComponent(challenge)}`;

      const msg = `# human.tech Covenant Signatory Verification

Connect the wallet used to sign the covenant and sign the challenge below.

🔗 Click the link (desktop MetaMask, mobile MetaMask, WalletConnect supported):
${signerUrl}

Verification will complete automatically.`;

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: msg, ephemeral: true });
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }

      await channel.send(msg);

    } catch (err) {
      console.error(err);
      const msg = "❌ Failed to create verification channel.";
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: msg, ephemeral: true });
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    }
  }
});

// ---------------- SIGNATURE ENDPOINT ----------------
app.post("/api/signature", async (req, res) => {
  const { userId, signature } = req.body;
  if (!userId || !signature) return res.status(400).json({ error: "Missing userId or signature" });

  const data = challenges.get(userId);
  if (!data) return res.status(400).json({ error: "No active verification for this user" });

  try {
    const recovered = ethers.verifyMessage(data.challenge, signature);
    if (recovered.toLowerCase() !== data.wallet.toLowerCase()) {
      return res.status(400).json({ error: "Signature does not match wallet" });
    }

    const guild = client.guilds.cache.get(GUILD_ID);
    const member = await guild.members.fetch(userId);
    const role = guild.roles.cache.find(r => r.name === "Covenant Verified Signatory");
    if (role) await member.roles.add(role);

    challenges.delete(userId);

    const channel = member.guild.channels.cache.find(c => c.name === `verify-${member.user.username}`);
    if (channel) setTimeout(() => channel.delete().catch(() => {}), 5000);

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Verification failed" });
  }
});

// ---------------- LOGIN ----------------
client.login(TOKEN);

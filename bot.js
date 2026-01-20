require("dotenv").config();
const express = require("express");
const { Client, GatewayIntentBits, REST, Routes, PermissionsBitField, ChannelType, SlashCommandBuilder } = require("discord.js");
const fetch = (...args) => import("node-fetch").then(({default: fetch}) => fetch(...args));
const { ethers } = require("ethers");

// ================== CONFIG ==================
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const API_KEY = process.env.WHITELIST_API_KEY;

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !API_KEY) {
  console.error("BOT_TOKEN, CLIENT_ID, GUILD_ID, or WHITELIST_API_KEY not set");
  process.exit(1);
}

const API_URL = "http://manifest.human.tech/api/covenant/signers-export";

// ================== DUMMY HTTP SERVER ==================
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Bot running"));
app.listen(PORT, () => console.log(`Dummy server running on port ${PORT}`));

// ================== DISCORD CLIENT ==================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const challenges = new Map();

// ---------------- REGISTER SLASH COMMANDS ----------------
(async () => {
  const commands = [
    new SlashCommandBuilder()
      .setName("verify")
      .setDescription("Start wallet verification"),
    new SlashCommandBuilder()
      .setName("signature")
      .setDescription("Submit your signature")
      .addStringOption(opt =>
        opt.setName("value")
          .setDescription("Paste your signature")
          .setRequired(true)
      )
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
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // ---------- /verify ----------
  if (interaction.commandName === "verify") {
    try {
      const guild = interaction.guild;
      const member = interaction.member;

      const channel = await guild.channels.create({
        name: `verify-${member.user.username}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
        ]
      });

      const challenge = `Verify ownership for ${member.id} at ${Date.now()}`;
      challenges.set(member.id, challenge);

      await channel.send(`
🔐 **Wallet Verification**

1. Open signer page  
2. Connect wallet  
3. Sign the message below  

\`\`\`
${challenge}
\`\`\`

Then submit:

\`\`\`
/signature <your_signature>
\`\`\`
      `);

      await interaction.reply({ content: `Private verification channel created: ${channel}`, ephemeral: true });
    } catch (err) {
      console.error(err);
      interaction.reply({ content: "❌ Failed to create channel.", ephemeral: true });
    }
  }

  // ---------- /signature ----------
  if (interaction.commandName === "signature") {
    const sig = interaction.options.getString("value");
    const challenge = challenges.get(interaction.user.id);

    if (!challenge) {
      return interaction.reply({ content: "❌ No active verification.", ephemeral: true });
    }

    try {
      const wallet = ethers.verifyMessage(challenge, sig);
      const list = await fetchWhitelist();

      const approved = list.find(w =>
        w.walletAddress?.toLowerCase() === wallet.toLowerCase() &&
        w.covenantStatus?.toUpperCase() === "SIGNED"
      );

      if (!approved) {
        return interaction.reply({ content: "❌ Wallet not approved for verification.", ephemeral: true });
      }

      const role = interaction.guild.roles.cache.find(r => r.name === "Human ID Verified");
      if (role) await interaction.member.roles.add(role);

      await interaction.reply("✅ Verified! Role assigned.");

      setTimeout(() => interaction.channel.delete(), 5000);
      challenges.delete(interaction.user.id);

    } catch (err) {
      console.error(err);
      interaction.reply({ content: "❌ Invalid signature.", ephemeral: true });
    }
  }
});

// ---------------- LOGIN ----------------
client.login(TOKEN);

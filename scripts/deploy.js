const { ethers } = require("hardhat");

// Three admin addresses for the 2-of-3 multisig. Set ADMIN_A / ADMIN_B /
// ADMIN_C in .env for a real deployment (e.g. Sepolia). For a local demo
// with no .env set, this falls back to the first three Hardhat signers so
// `npx hardhat run scripts/deploy.js` still works out of the box.
async function resolveAdmins() {
  if (process.env.ADMIN_A && process.env.ADMIN_B && process.env.ADMIN_C) {
    return [process.env.ADMIN_A, process.env.ADMIN_B, process.env.ADMIN_C];
  }
  const signers = await ethers.getSigners();
  if (signers.length < 3) {
    throw new Error("Need at least 3 accounts to deploy — set ADMIN_A/ADMIN_B/ADMIN_C in .env instead.");
  }
  console.log("ADMIN_A/B/C not set in .env — using the first three local signers for this deployment.");
  return [signers[0].address, signers[1].address, signers[2].address];
}

async function main() {
  const admins = await resolveAdmins();
  console.log("Deploying with admins:", admins);

  const VeriDegree = await ethers.getContractFactory("VeriDegree");
  const veriDegree = await VeriDegree.deploy(admins);
  await veriDegree.waitForDeployment();

  console.log("VeriDegree deployed to:", await veriDegree.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

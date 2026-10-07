const { expect } = require("chai");
const { ethers } = require("hardhat");

// Helper: encode a call to one of the contract's own admin functions, for
// use as the `data` argument to proposeAdminAction/confirmAdminAction.
function encode(veriDegree, fnName, args) {
  return veriDegree.interface.encodeFunctionData(fnName, args);
}

describe("VeriDegree", function () {
  let veriDegree, adminA, adminB, adminC, institution, otherInstitution, student, stranger;
  const certHash = ethers.keccak256(ethers.toUtf8Bytes("cert-001"));

  beforeEach(async function () {
    [adminA, adminB, adminC, institution, otherInstitution, student, stranger] = await ethers.getSigners();

    const VeriDegree = await ethers.getContractFactory("VeriDegree");
    veriDegree = await VeriDegree.deploy([adminA.address, adminB.address, adminC.address]);
  });

  // Propose + confirm an admin action with 2 of the 3 admins, in one helper.
  async function runAdminAction(fnName, args, proposer = adminA, confirmer = adminB) {
    const data = encode(veriDegree, fnName, args);
    const tx = await veriDegree.connect(proposer).proposeAdminAction(data);
    const receipt = await tx.wait();
    const proposalId = veriDegree.interface.parseLog(receipt.logs[0]).args.proposalId;
    await veriDegree.connect(confirmer).confirmAdminAction(proposalId);
    return proposalId;
  }

  describe("deployment", function () {
    it("sets the three admins", async function () {
      expect(await veriDegree.getAdmins()).to.deep.equal([adminA.address, adminB.address, adminC.address]);
      expect(await veriDegree.isAdmin(adminA.address)).to.equal(true);
      expect(await veriDegree.isAdmin(stranger.address)).to.equal(false);
    });

    it("starts with no credentials issued", async function () {
      expect(await veriDegree.nextCredentialId()).to.equal(0);
    });

    it("rejects a zero address as an admin", async function () {
      const VeriDegree = await ethers.getContractFactory("VeriDegree");
      await expect(
        VeriDegree.deploy([adminA.address, ethers.ZeroAddress, adminC.address])
      ).to.be.revertedWithCustomError(veriDegree, "ZeroAddress");
    });

    it("rejects duplicate admin addresses", async function () {
      const VeriDegree = await ethers.getContractFactory("VeriDegree");
      await expect(
        VeriDegree.deploy([adminA.address, adminA.address, adminC.address])
      ).to.be.revertedWithCustomError(veriDegree, "DuplicateAdmin");
    });
  });

  describe("admin multisig", function () {
    it("does not execute an admin action on a single confirmation", async function () {
      const data = encode(veriDegree, "addInstitution", [institution.address]);
      await veriDegree.connect(adminA).proposeAdminAction(data);

      expect(await veriDegree.approvedInstitutions(institution.address)).to.equal(false);
    });

    it("executes an admin action once a 2nd distinct admin confirms", async function () {
      const proposalId = await runAdminAction("addInstitution", [institution.address], adminA, adminC);

      expect(await veriDegree.approvedInstitutions(institution.address)).to.equal(true);
      const proposal = await veriDegree.proposals(proposalId);
      expect(proposal.executed).to.equal(true);
    });

    it("emits ProposalCreated, ProposalConfirmed and ProposalExecuted", async function () {
      const data = encode(veriDegree, "addInstitution", [institution.address]);
      const tx1 = await veriDegree.connect(adminA).proposeAdminAction(data);
      await expect(tx1).to.emit(veriDegree, "ProposalCreated").withArgs(0, adminA.address, data);
      await expect(tx1).to.emit(veriDegree, "ProposalConfirmed").withArgs(0, adminA.address, 1);

      await expect(veriDegree.connect(adminB).confirmAdminAction(0))
        .to.emit(veriDegree, "ProposalConfirmed").withArgs(0, adminB.address, 2)
        .and.to.emit(veriDegree, "ProposalExecuted").withArgs(0);
    });

    it("rejects a non-admin proposing an action", async function () {
      const data = encode(veriDegree, "addInstitution", [institution.address]);
      await expect(
        veriDegree.connect(stranger).proposeAdminAction(data)
      ).to.be.revertedWithCustomError(veriDegree, "NotAdmin");
    });

    it("rejects a non-admin confirming an action", async function () {
      const data = encode(veriDegree, "addInstitution", [institution.address]);
      await veriDegree.connect(adminA).proposeAdminAction(data);

      await expect(
        veriDegree.connect(stranger).confirmAdminAction(0)
      ).to.be.revertedWithCustomError(veriDegree, "NotAdmin");
    });

    it("rejects the same admin confirming twice", async function () {
      const data = encode(veriDegree, "addInstitution", [institution.address]);
      await veriDegree.connect(adminA).proposeAdminAction(data);

      await expect(
        veriDegree.connect(adminA).confirmAdminAction(0)
      ).to.be.revertedWithCustomError(veriDegree, "AlreadyConfirmed");
    });

    it("rejects confirming an already-executed proposal", async function () {
      await runAdminAction("addInstitution", [institution.address], adminA, adminB);

      await expect(
        veriDegree.connect(adminC).confirmAdminAction(0)
      ).to.be.revertedWithCustomError(veriDegree, "AlreadyExecuted");
    });

    it("rejects confirming a proposal ID that does not exist", async function () {
      await expect(
        veriDegree.connect(adminA).confirmAdminAction(99)
      ).to.be.revertedWithCustomError(veriDegree, "ProposalNotFound");
    });

    it("still works with the third admin covering for a lost key (any 2 of 3)", async function () {
      // adminA "loses their key" -> simply never participates.
      await runAdminAction("addInstitution", [institution.address], adminB, adminC);
      expect(await veriDegree.approvedInstitutions(institution.address)).to.equal(true);
    });

    it("rejects a direct (non-multisig) call to an admin function", async function () {
      await expect(
        veriDegree.connect(adminA).addInstitution(institution.address)
      ).to.be.revertedWithCustomError(veriDegree, "NotSelf");
    });
  });

  describe("institution management", function () {
    it("adds an institution via 2-of-3 admin approval", async function () {
      await runAdminAction("addInstitution", [institution.address]);
      expect(await veriDegree.approvedInstitutions(institution.address)).to.equal(true);
    });

    it("removes an institution via 2-of-3 admin approval", async function () {
      await runAdminAction("addInstitution", [institution.address]);
      await runAdminAction("removeInstitution", [institution.address]);
      expect(await veriDegree.approvedInstitutions(institution.address)).to.equal(false);
    });

    it("sets an institution's display name via 2-of-3 admin approval", async function () {
      await runAdminAction("addInstitution", [institution.address]);
      await runAdminAction("setInstitutionName", [institution.address, "Atria University"]);
      expect(await veriDegree.institutionNames(institution.address)).to.equal("Atria University");
    });
  });

  describe("issuing credentials", function () {
    beforeEach(async function () {
      await runAdminAction("addInstitution", [institution.address]);
    });

    it("lets an approved institution issue a credential independently (no multisig needed)", async function () {
      const tx = await veriDegree.connect(institution).issueCredential(certHash, student.address);
      const block = await ethers.provider.getBlock(tx.blockNumber);

      await expect(tx)
        .to.emit(veriDegree, "CredentialIssued")
        .withArgs(0, institution.address, student.address, certHash, block.timestamp);

      expect(await veriDegree.nextCredentialId()).to.equal(1);
    });

    it("stores the credential data correctly", async function () {
      await veriDegree.connect(institution).issueCredential(certHash, student.address);

      const [hash, inst, stud, , isValid] = await veriDegree.verifyCredential(0);
      expect(hash).to.equal(certHash);
      expect(inst).to.equal(institution.address);
      expect(stud).to.equal(student.address);
      expect(isValid).to.equal(true);
    });

    it("records the credential under the student", async function () {
      await veriDegree.connect(institution).issueCredential(certHash, student.address);
      await veriDegree.connect(institution).issueCredential(certHash, student.address);

      const ids = await veriDegree.getStudentCredentials(student.address);
      expect(ids.map(Number)).to.deep.equal([0, 1]);
    });

    it("rejects issuance from an unapproved institution", async function () {
      await expect(
        veriDegree.connect(stranger).issueCredential(certHash, student.address)
      ).to.be.revertedWithCustomError(veriDegree, "NotApprovedInstitution");
    });

    it("rejects a zero student address", async function () {
      await expect(
        veriDegree.connect(institution).issueCredential(certHash, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(veriDegree, "ZeroAddress");
    });

    it("rejects an empty certificate hash", async function () {
      await expect(
        veriDegree.connect(institution).issueCredential(ethers.ZeroHash, student.address)
      ).to.be.revertedWithCustomError(veriDegree, "EmptyHash");
    });

    it("blocks issuance from an institution after 2-of-3 admins remove it", async function () {
      await runAdminAction("removeInstitution", [institution.address]);

      await expect(
        veriDegree.connect(institution).issueCredential(certHash, student.address)
      ).to.be.revertedWithCustomError(veriDegree, "NotApprovedInstitution");
    });

    it("keeps a previously issued credential intact after its institution is removed", async function () {
      await veriDegree.connect(institution).issueCredential(certHash, student.address);
      await runAdminAction("removeInstitution", [institution.address]);

      const [hash, inst, stud, , isValid] = await veriDegree.verifyCredential(0);
      expect(hash).to.equal(certHash);
      expect(inst).to.equal(institution.address);
      expect(stud).to.equal(student.address);
      expect(isValid).to.equal(true);
    });
  });

  describe("revoking credentials", function () {
    beforeEach(async function () {
      await runAdminAction("addInstitution", [institution.address]);
      await veriDegree.connect(institution).issueCredential(certHash, student.address);
    });

    it("lets the issuing institution revoke its own credential directly", async function () {
      await expect(veriDegree.connect(institution).revokeCredential(0))
        .to.emit(veriDegree, "CredentialRevoked");

      const [, , , , isValid] = await veriDegree.verifyCredential(0);
      expect(isValid).to.equal(false);
    });

    it("lets the admin multisig revoke a credential it did not issue", async function () {
      await runAdminAction("revokeCredential", [0]);

      const [, , , , isValid] = await veriDegree.verifyCredential(0);
      expect(isValid).to.equal(false);
    });

    it("rejects a single admin revoking directly, without the multisig", async function () {
      await expect(
        veriDegree.connect(adminA).revokeCredential(0)
      ).to.be.revertedWithCustomError(veriDegree, "NotIssuerOrAdmin");
    });

    it("rejects revocation from an unrelated stranger", async function () {
      await expect(
        veriDegree.connect(stranger).revokeCredential(0)
      ).to.be.revertedWithCustomError(veriDegree, "NotIssuerOrAdmin");
    });

    it("rejects revoking an already-revoked credential", async function () {
      await veriDegree.connect(institution).revokeCredential(0);

      await expect(
        veriDegree.connect(institution).revokeCredential(0)
      ).to.be.revertedWithCustomError(veriDegree, "AlreadyRevoked");
    });

    it("rejects revoking a credential that does not exist", async function () {
      await expect(
        veriDegree.connect(institution).revokeCredential(99)
      ).to.be.revertedWithCustomError(veriDegree, "InvalidCredential");
    });

    it("stops one institution from revoking another institution's credential", async function () {
      await runAdminAction("addInstitution", [otherInstitution.address]);

      await expect(
        veriDegree.connect(otherInstitution).revokeCredential(0)
      ).to.be.revertedWithCustomError(veriDegree, "NotIssuerOrAdmin");
    });
  });

  describe("wallet recovery", function () {
    let newWallet;

    beforeEach(async function () {
      [, , , , , , newWallet] = await ethers.getSigners();
      await runAdminAction("addInstitution", [institution.address]);
      await veriDegree.connect(institution).issueCredential(certHash, student.address);
    });

    it("lets the issuing institution move a credential to a new student wallet directly (no multisig needed)", async function () {
      const tx = await veriDegree.connect(institution).updateCredentialStudent(0, newWallet.address);
      const block = await ethers.provider.getBlock(tx.blockNumber);

      await expect(tx)
        .to.emit(veriDegree, "CredentialStudentUpdated")
        .withArgs(0, student.address, newWallet.address, block.timestamp);

      const [, , stud] = await veriDegree.verifyCredential(0);
      expect(stud).to.equal(newWallet.address);
    });

    it("rejects a non-issuer trying to update the student wallet", async function () {
      await expect(
        veriDegree.connect(stranger).updateCredentialStudent(0, newWallet.address)
      ).to.be.revertedWithCustomError(veriDegree, "NotIssuer");
    });

    it("rejects the admin multisig itself from updating a wallet it did not issue", async function () {
      const data = encode(veriDegree, "updateCredentialStudent", [0, newWallet.address]);
      const tx = await veriDegree.connect(adminA).proposeAdminAction(data);
      const receipt = await tx.wait();
      const proposalId = veriDegree.interface.parseLog(receipt.logs[0]).args.proposalId;

      // 2nd confirmation triggers the self-call, which reverts inside;
      // the multisig surfaces that as ProposalExecutionFailed.
      await expect(
        veriDegree.connect(adminB).confirmAdminAction(proposalId)
      ).to.be.revertedWithCustomError(veriDegree, "ProposalExecutionFailed");
    });

    it("rejects the zero address as the new student wallet", async function () {
      await expect(
        veriDegree.connect(institution).updateCredentialStudent(0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(veriDegree, "ZeroAddress");
    });

    it("rejects updating a revoked credential's wallet", async function () {
      await veriDegree.connect(institution).revokeCredential(0);

      await expect(
        veriDegree.connect(institution).updateCredentialStudent(0, newWallet.address)
      ).to.be.revertedWithCustomError(veriDegree, "AlreadyRevoked");
    });

    it("removes the credential from the old student's list", async function () {
      await veriDegree.connect(institution).updateCredentialStudent(0, newWallet.address);

      const oldIds = await veriDegree.getStudentCredentials(student.address);
      expect(oldIds.map(Number)).to.deep.equal([]);
    });

    it("adds the credential to the new student's list", async function () {
      await veriDegree.connect(institution).updateCredentialStudent(0, newWallet.address);

      const newIds = await veriDegree.getStudentCredentials(newWallet.address);
      expect(newIds.map(Number)).to.deep.equal([0]);
    });

    it("does not create duplicate credential IDs for the new student", async function () {
      await veriDegree.connect(institution).issueCredential(certHash, newWallet.address);
      await veriDegree.connect(institution).updateCredentialStudent(0, newWallet.address);

      const ids = await veriDegree.getStudentCredentials(newWallet.address);
      expect(ids.map(Number).sort()).to.deep.equal([0, 1]);
      expect(new Set(ids.map(Number)).size).to.equal(ids.length);
    });
  });

  describe("privacy: on-chain data minimalism", function () {
    it("stores only the hash, addresses, timestamp and status — no personal data", async function () {
      await runAdminAction("addInstitution", [institution.address]);
      await veriDegree.connect(institution).issueCredential(certHash, student.address);

      const [hash, inst, stud, issuedAt, isValid] = await veriDegree.verifyCredential(0);

      expect(hash).to.equal(certHash);
      expect(inst).to.equal(institution.address);
      expect(stud).to.equal(student.address);
      expect(issuedAt).to.be.a("bigint");
      expect(isValid).to.equal(true);
    });
  });

  describe("verification", function () {
    it("rejects looking up a credential that does not exist", async function () {
      await expect(
        veriDegree.verifyCredential(0)
      ).to.be.revertedWithCustomError(veriDegree, "InvalidCredential");
    });

    it("is callable by anyone, not just an admin or institution", async function () {
      await runAdminAction("addInstitution", [institution.address]);
      await veriDegree.connect(institution).issueCredential(certHash, student.address);

      const [, , , , isValid] = await veriDegree.connect(stranger).verifyCredential(0);
      expect(isValid).to.equal(true);
    });

    it("returns an empty list for a student with no credentials", async function () {
      const ids = await veriDegree.getStudentCredentials(stranger.address);
      expect(ids.length).to.equal(0);
    });
  });

  describe("security: no Ether handling", function () {
    it("rejects a plain Ether transfer to the contract", async function () {
      await expect(
        adminA.sendTransaction({ to: await veriDegree.getAddress(), value: 1 })
      ).to.be.reverted;
    });
  });
});

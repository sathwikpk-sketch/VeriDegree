// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title VeriDegree — on-chain academic credential registry
/// @notice Stores a hash of each credential plus minimal metadata needed to
///         verify it. No personal data or documents are ever stored here —
///         see the "Privacy model" note above `credentials` below.
contract VeriDegree {
    struct Credential {
        bytes32 certHash;
        address institution;
        address student;
        uint256 issuedAt;
        bool revoked;
    }

    // ------------------------------------------------------------------
    // Admin multisig (2-of-3)
    //
    // There is no single "owner" key. Three fixed admin addresses are set
    // once, at deployment. Any *critical administrative* action — adding
    // an institution, removing one, or setting its display name — needs
    // confirmation from at least 2 of the 3 admins before it takes effect.
    // This is done with a tiny propose/confirm/execute pattern: one admin
    // proposes an action (as ABI-encoded calldata for a function on this
    // same contract), a second admin confirms it, and on the 2nd
    // confirmation the contract calls itself to actually run it. The
    // target functions (`addInstitution` etc.) are marked `onlySelf`, so
    // they can only ever be reached through that path — never directly.
    //
    // The multisig governs ADMIN actions only. It never sits between an
    // approved institution and issuing, revoking its own credential, or
    // recovering a student wallet — those stay fast and institution-only,
    // exactly as before. Losing one admin key does not stop the system:
    // the other two can still act. Losing two at once has no on-chain
    // recovery path in this design — see "Assumptions and Limitations".
    // ------------------------------------------------------------------
    uint256 public constant ADMIN_QUORUM = 2;
    address[3] public admins;
    mapping(address => bool) public isAdmin;

    struct Proposal {
        bytes data;
        uint256 confirmations;
        bool executed;
    }

    uint256 public nextProposalId;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasConfirmed;

    /// @dev Institution whitelist — unchanged from the original design.
    ///      true  = this address may currently issue credentials.
    ///      false = it may not (either never approved, or removed).
    mapping(address => bool) public approvedInstitutions;

    /// @dev OPTIONAL display metadata only (e.g. "Atria University").
    ///      This is NOT a trust signal — the chain cannot verify that a
    ///      name is truthful. `approvedInstitutions` is what actually
    ///      controls who may issue. A name may be set for an address
    ///      whether or not it is currently approved.
    mapping(address => string) public institutionNames;

    uint256 public nextCredentialId;

    // ------------------------------------------------------------------
    // Privacy model (read this before storing anything new here):
    //   PUBLIC on-chain  : certHash, institution, student address,
    //                      issuedAt, revoked status.
    //   PRIVATE off-chain : student name, email, phone, DOB, address,
    //                      the certificate file itself.
    // This contract only ever stores the public side. A public blockchain
    // cannot make data confidential — a `private` Solidity variable is
    // still readable by anyone via the state trie. Access control here
    // (`onlySelf`, `onlyApprovedInstitution`, etc.) restricts who can
    // *write*, never who can *read*. Private data belongs in an off-chain
    // encrypted store, retrieved by an authorized backend after it
    // separately authenticates the caller. Two different questions, two
    // different systems:
    //   "Is this credential genuine and active?"      -> this contract
    //   "Is this caller allowed to see the student's
    //    private record?"                             -> the backend
    // ------------------------------------------------------------------
    mapping(uint256 => Credential) public credentials;
    mapping(address => uint256[]) public studentCredentials;

    error NotAdmin();
    error NotSelf();
    error DuplicateAdmin();
    error ProposalNotFound();
    error AlreadyExecuted();
    error AlreadyConfirmed();
    error ProposalExecutionFailed();
    error NotApprovedInstitution();
    error NotIssuerOrAdmin();
    error NotIssuer();
    error ZeroAddress();
    error EmptyHash();
    error InvalidCredential();
    error AlreadyRevoked();

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, bytes data);
    event ProposalConfirmed(uint256 indexed proposalId, address indexed admin, uint256 confirmations);
    event ProposalExecuted(uint256 indexed proposalId);
    event InstitutionAdded(address indexed institution);
    event InstitutionRemoved(address indexed institution);
    event InstitutionNameSet(address indexed institution, string name);
    event CredentialIssued(
        uint256 indexed credentialId,
        address indexed institution,
        address indexed student,
        bytes32 certHash,
        uint256 issuedAt
    );
    event CredentialRevoked(uint256 indexed credentialId, address indexed revokedBy, uint256 revokedAt);
    event CredentialStudentUpdated(
        uint256 indexed credentialId,
        address indexed oldStudent,
        address indexed newStudent,
        uint256 updatedAt
    );

    modifier onlyAdmin() {
        if (!isAdmin[msg.sender]) revert NotAdmin();
        _;
    }

    /// @dev Restricts a function to being called by the contract itself,
    ///      i.e. only as the result of an executed 2-of-3 admin proposal.
    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    modifier onlyApprovedInstitution() {
        if (!approvedInstitutions[msg.sender]) revert NotApprovedInstitution();
        _;
    }

    /// @param _admins Exactly 3 distinct, non-zero admin addresses.
    ///        Any 2 of them can jointly perform admin actions afterward.
    constructor(address[3] memory _admins) {
        for (uint256 i = 0; i < 3; i++) {
            if (_admins[i] == address(0)) revert ZeroAddress();
            for (uint256 j = i + 1; j < 3; j++) {
                if (_admins[i] == _admins[j]) revert DuplicateAdmin();
            }
        }
        admins = _admins;
        isAdmin[_admins[0]] = true;
        isAdmin[_admins[1]] = true;
        isAdmin[_admins[2]] = true;
    }

    function getAdmins() external view returns (address[3] memory) {
        return admins;
    }

    // ------------------------------------------------------------------
    // Admin multisig: propose, confirm, auto-execute at 2 confirmations.
    // ------------------------------------------------------------------

    /// @notice Propose a critical admin action, e.g. an `addInstitution`
    ///         call encoded as calldata. Counts as the proposer's own
    ///         confirmation, so a second admin's confirmation is enough
    ///         to execute it.
    function proposeAdminAction(bytes calldata data) external onlyAdmin returns (uint256 proposalId) {
        proposalId = nextProposalId++;
        proposals[proposalId] = Proposal({data: data, confirmations: 0, executed: false});
        emit ProposalCreated(proposalId, msg.sender, data);
        _confirm(proposalId);
    }

    /// @notice Add a confirmation to an existing proposal. Executes it
    ///         automatically once 2 distinct admins have confirmed.
    function confirmAdminAction(uint256 proposalId) external onlyAdmin {
        if (proposalId >= nextProposalId) revert ProposalNotFound();
        _confirm(proposalId);
    }

    function _confirm(uint256 proposalId) private {
        Proposal storage p = proposals[proposalId];
        if (p.executed) revert AlreadyExecuted();
        if (hasConfirmed[proposalId][msg.sender]) revert AlreadyConfirmed();

        hasConfirmed[proposalId][msg.sender] = true;
        p.confirmations++;
        emit ProposalConfirmed(proposalId, msg.sender, p.confirmations);

        if (p.confirmations >= ADMIN_QUORUM) {
            p.executed = true;
            (bool success, ) = address(this).call(p.data);
            if (!success) revert ProposalExecutionFailed();
            emit ProposalExecuted(proposalId);
        }
    }

    // ------------------------------------------------------------------
    // Admin actions. Each is `onlySelf`: reachable only through a
    // confirmed 2-of-3 proposal above, never by a direct call — including
    // from an individual admin.
    // ------------------------------------------------------------------

    function addInstitution(address inst) external onlySelf {
        if (inst == address(0)) revert ZeroAddress();
        approvedInstitutions[inst] = true;
        emit InstitutionAdded(inst);
    }

    /// @notice Prevents FUTURE issuance only. Credentials this institution
    ///         already issued stay exactly as they are — they are not
    ///         deleted, hidden, or revoked by this call. If those records
    ///         should also stop being trusted, revoke them individually
    ///         (see `revokeCredential`); removal and revocation are
    ///         deliberately separate actions.
    function removeInstitution(address inst) external onlySelf {
        approvedInstitutions[inst] = false;
        emit InstitutionRemoved(inst);
    }

    /// @notice Optional display name for an institution address. Purely
    ///         informational — set it before or after approval, it has no
    ///         effect on `approvedInstitutions`.
    function setInstitutionName(address inst, string calldata name) external onlySelf {
        if (inst == address(0)) revert ZeroAddress();
        institutionNames[inst] = name;
        emit InstitutionNameSet(inst, name);
    }

    function issueCredential(bytes32 certHash, address student) external onlyApprovedInstitution returns (uint256) {
        if (student == address(0)) revert ZeroAddress();
        if (certHash == bytes32(0)) revert EmptyHash();

        uint256 id = nextCredentialId++;

        credentials[id] = Credential({
            certHash: certHash,
            institution: msg.sender,
            student: student,
            issuedAt: block.timestamp,
            revoked: false
        });

        studentCredentials[student].push(id);

        emit CredentialIssued(id, msg.sender, student, certHash, block.timestamp);
        return id;
    }

    /// @notice The issuing institution can revoke its own credential at
    ///         any time. As an emergency/global action, the admin
    ///         multisig can also revoke any credential (e.g. if an
    ///         issuer's key is later found compromised) — reached only
    ///         through a confirmed 2-of-3 proposal, the same as any other
    ///         admin action, so `msg.sender` in that case is this
    ///         contract's own address. No individual admin, and no other
    ///         institution, can revoke a credential directly.
    function revokeCredential(uint256 credentialId) external {
        if (credentialId >= nextCredentialId) revert InvalidCredential();

        Credential storage cred = credentials[credentialId];
        if (msg.sender != cred.institution && msg.sender != address(this)) revert NotIssuerOrAdmin();
        if (cred.revoked) revert AlreadyRevoked();

        cred.revoked = true;
        emit CredentialRevoked(credentialId, msg.sender, block.timestamp);
    }

    /// @notice Wallet-loss recovery. Only the institution that originally
    ///         issued this exact credential may move it to a new student
    ///         address — not the admins, not the old wallet itself, and
    ///         not any other institution. This intentionally stays
    ///         outside the multisig: recovery is a fast service the
    ///         issuer provides to its own students, not a global admin
    ///         power, so it should not need to wait on a second admin's
    ///         confirmation.
    /// @dev Reverts on a revoked credential — once revoked, a credential is
    ///      dead and should not be reassigned to a new wallet.
    function updateCredentialStudent(uint256 credentialId, address newStudent) external {
        if (credentialId >= nextCredentialId) revert InvalidCredential();

        Credential storage cred = credentials[credentialId];
        if (msg.sender != cred.institution) revert NotIssuer();
        if (newStudent == address(0)) revert ZeroAddress();
        if (cred.revoked) revert AlreadyRevoked();

        address oldStudent = cred.student;
        _removeCredentialFromStudent(oldStudent, credentialId);

        cred.student = newStudent;
        studentCredentials[newStudent].push(credentialId);

        emit CredentialStudentUpdated(credentialId, oldStudent, newStudent, block.timestamp);
    }

    /// @dev Swap-and-pop removal of `credentialId` from `student`'s list.
    ///      Order within the list is not part of this contract's API, so
    ///      this is safe: `getStudentCredentials` never promised ordering.
    function _removeCredentialFromStudent(address student, uint256 credentialId) private {
        uint256[] storage ids = studentCredentials[student];
        uint256 len = ids.length;
        for (uint256 i = 0; i < len; i++) {
            if (ids[i] == credentialId) {
                ids[i] = ids[len - 1];
                ids.pop();
                break;
            }
        }
    }

    function verifyCredential(uint256 credentialId)
        external
        view
        returns (bytes32 certHash, address institution, address student, uint256 issuedAt, bool isValid)
    {
        if (credentialId >= nextCredentialId) revert InvalidCredential();

        Credential storage cred = credentials[credentialId];
        return (cred.certHash, cred.institution, cred.student, cred.issuedAt, !cred.revoked);
    }

    function getStudentCredentials(address student) external view returns (uint256[] memory) {
        return studentCredentials[student];
    }
}
